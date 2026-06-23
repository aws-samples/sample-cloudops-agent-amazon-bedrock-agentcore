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
exports.MCPRuntimeStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const events = __importStar(require("aws-cdk-lib/aws-events"));
const events_targets = __importStar(require("aws-cdk-lib/aws-events-targets"));
const path = __importStar(require("path"));
const cdk_nag_1 = require("cdk-nag");
class MCPRuntimeStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // ========================================
        // IAM Roles for MCP Runtimes
        // ========================================
        // Billing MCP Server Runtime Role
        const billingMcpRuntimeRole = new iam.Role(this, 'BillingMcpRuntimeRole', {
            roleName: `${this.stackName}-BillingMcpRuntimeRole`,
            assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        });
        // Pricing MCP Server Runtime Role
        const pricingMcpRuntimeRole = new iam.Role(this, 'PricingMcpRuntimeRole', {
            roleName: `${this.stackName}-PricingMcpRuntimeRole`,
            assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        });
        // Common AgentCore Runtime permissions (ECR, CloudWatch, X-Ray, Bedrock, Gateway)
        const commonRuntimePermissions = [
            // ECR token access
            new iam.PolicyStatement({
                sid: 'ECRTokenAccess',
                effect: iam.Effect.ALLOW,
                actions: ['ecr:GetAuthorizationToken'],
                resources: ['*'],
            }),
            // CloudWatch Logs
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['logs:DescribeLogGroups'],
                resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`],
            }),
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['logs:DescribeLogStreams', 'logs:CreateLogGroup'],
                resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`],
            }),
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`],
            }),
            // Gateway invocation
            new iam.PolicyStatement({
                sid: 'AllowGatewayInvocation',
                effect: iam.Effect.ALLOW,
                actions: ['bedrock-agentcore:InvokeGateway'],
                resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`],
            }),
        ];
        // Add common permissions to both roles
        for (const stmt of commonRuntimePermissions) {
            billingMcpRuntimeRole.addToPolicy(stmt);
            pricingMcpRuntimeRole.addToPolicy(stmt);
        }
        // ECR image pull for each role's specific repository
        props.billingMcpRepository.grantPull(billingMcpRuntimeRole);
        props.pricingMcpRepository.grantPull(pricingMcpRuntimeRole);
        // Add Cost Explorer and billing permissions to Billing MCP Runtime
        billingMcpRuntimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'ce:*',
                'budgets:*',
                'compute-optimizer:*',
                'freetier:*',
                'cost-optimization-hub:*',
                'pricing:GetProducts',
                'pricing:GetAttributeValues',
                'pricing:DescribeServices',
                'pricing:ListPriceListFiles',
                'pricing:GetPriceListFileUrl',
                'ec2:DescribeInstances',
                'ec2:DescribeVolumes',
                'ec2:DescribeInstanceTypes',
                'ec2:DescribeRegions',
                'autoscaling:DescribeAutoScalingGroups',
                'lambda:ListFunctions',
                'lambda:GetFunction',
                'ecs:ListClusters',
                'ecs:ListServices',
                'ecs:DescribeServices',
            ],
            resources: ['*'],
        }));
        // Add Pricing API permissions to Pricing MCP Runtime
        pricingMcpRuntimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'pricing:GetProducts',
                'pricing:GetAttributeValues',
                'pricing:DescribeServices',
                'pricing:ListPriceListFiles',
                'pricing:GetPriceListFileUrl',
            ],
            resources: ['*'],
        }));
        // ========================================
        // MCP Runtimes with JWT Authorization
        // Gateway sends OAuth Bearer tokens, Runtimes validate JWT
        // ========================================
        // Billing MCP Server Runtime
        const cfnBillingMcpRuntime = new cdk.CfnResource(this, 'BillingMcpRuntime', {
            type: 'AWS::BedrockAgentCore::Runtime',
            properties: {
                AgentRuntimeName: 'cloudops_billing_mcp_jwt_v1',
                Description: 'AWS Labs Billing MCP Server Runtime with JWT authorization',
                RoleArn: billingMcpRuntimeRole.roleArn,
                AuthorizerConfiguration: {
                    CustomJWTAuthorizer: {
                        AllowedClients: [props.m2mClientId],
                        DiscoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${props.userPoolId}/.well-known/openid-configuration`,
                    }
                },
                AgentRuntimeArtifact: {
                    ContainerConfiguration: {
                        ContainerUri: `${props.billingMcpRepository.repositoryUri}:latest`
                    }
                },
                NetworkConfiguration: {
                    NetworkMode: 'PUBLIC'
                },
                EnvironmentVariables: {
                    AWS_REGION: this.region,
                    DEPLOYMENT_TIMESTAMP: new Date().toISOString(),
                },
                ProtocolConfiguration: 'MCP',
                LifecycleConfiguration: {},
            }
        });
        cfnBillingMcpRuntime.node.addDependency(billingMcpRuntimeRole);
        this.billingMcpRuntimeArn = cfnBillingMcpRuntime.getAtt('AgentRuntimeArn').toString();
        // MCP Runtime endpoint format for AgentCore Gateway targets (from AWS documentation)
        // Format: https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{ENCODED_ARN}/invocations?qualifier=DEFAULT
        // The ARN must be URL-encoded (: → %3A, / → %2F)
        // Reference: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html
        const encodedBillingArn = cdk.Fn.join('', [
            cdk.Fn.select(0, cdk.Fn.split(':', this.billingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(1, cdk.Fn.split(':', this.billingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(2, cdk.Fn.split(':', this.billingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(3, cdk.Fn.split(':', this.billingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(4, cdk.Fn.split(':', this.billingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.join('%2F', cdk.Fn.split('/', cdk.Fn.select(5, cdk.Fn.split(':', this.billingMcpRuntimeArn)))),
        ]);
        this.billingMcpRuntimeEndpoint = `https://bedrock-agentcore.${this.region}.amazonaws.com/runtimes/${encodedBillingArn}/invocations?qualifier=DEFAULT`;
        // Pricing MCP Server Runtime
        const cfnPricingMcpRuntime = new cdk.CfnResource(this, 'PricingMcpRuntime', {
            type: 'AWS::BedrockAgentCore::Runtime',
            properties: {
                AgentRuntimeName: 'cloudops_pricing_mcp_jwt_v1',
                Description: 'AWS Labs Pricing MCP Server Runtime with JWT authorization',
                RoleArn: pricingMcpRuntimeRole.roleArn,
                AuthorizerConfiguration: {
                    CustomJWTAuthorizer: {
                        AllowedClients: [props.m2mClientId],
                        DiscoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${props.userPoolId}/.well-known/openid-configuration`,
                    }
                },
                AgentRuntimeArtifact: {
                    ContainerConfiguration: {
                        ContainerUri: `${props.pricingMcpRepository.repositoryUri}:latest`
                    }
                },
                NetworkConfiguration: {
                    NetworkMode: 'PUBLIC'
                },
                EnvironmentVariables: {
                    AWS_REGION: this.region,
                    DEPLOYMENT_TIMESTAMP: new Date().toISOString(),
                },
                ProtocolConfiguration: 'MCP',
                LifecycleConfiguration: {},
            }
        });
        cfnPricingMcpRuntime.node.addDependency(pricingMcpRuntimeRole);
        this.pricingMcpRuntimeArn = cfnPricingMcpRuntime.getAtt('AgentRuntimeArn').toString();
        // MCP Runtime endpoint format for AgentCore Gateway targets (from AWS documentation)
        // Format: https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{ENCODED_ARN}/invocations?qualifier=DEFAULT
        // The ARN must be URL-encoded (: → %3A, / → %2F)
        // Reference: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html
        const encodedPricingArn = cdk.Fn.join('', [
            cdk.Fn.select(0, cdk.Fn.split(':', this.pricingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(1, cdk.Fn.split(':', this.pricingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(2, cdk.Fn.split(':', this.pricingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(3, cdk.Fn.split(':', this.pricingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(4, cdk.Fn.split(':', this.pricingMcpRuntimeArn)),
            '%3A',
            cdk.Fn.join('%2F', cdk.Fn.split('/', cdk.Fn.select(5, cdk.Fn.split(':', this.pricingMcpRuntimeArn)))),
        ]);
        this.pricingMcpRuntimeEndpoint = `https://bedrock-agentcore.${this.region}.amazonaws.com/runtimes/${encodedPricingArn}/invocations?qualifier=DEFAULT`;
        // ========================================
        // CloudWatch MCP Server Runtime
        // ========================================
        // CloudWatch MCP Server Runtime Role
        const cloudwatchMcpRuntimeRole = new iam.Role(this, 'CloudWatchMcpRuntimeRole', {
            roleName: `${this.stackName}-CloudWatchMcpRuntimeRole`,
            assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        });
        // Add common permissions to CloudWatch runtime role
        for (const stmt of commonRuntimePermissions) {
            cloudwatchMcpRuntimeRole.addToPolicy(stmt);
        }
        // ECR image pull for CloudWatch repository
        props.cloudwatchMcpRepository.grantPull(cloudwatchMcpRuntimeRole);
        // Grant CloudWatch and Logs permissions
        cloudwatchMcpRuntimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'cloudwatch:*',
                'logs:*',
            ],
            resources: ['*'],
        }));
        // CloudWatch MCP Server Runtime
        const cfnCloudWatchMcpRuntime = new cdk.CfnResource(this, 'CloudWatchMcpRuntime', {
            type: 'AWS::BedrockAgentCore::Runtime',
            properties: {
                AgentRuntimeName: 'cloudops_cloudwatch_mcp_jwt_v1',
                Description: 'AWS Labs CloudWatch MCP Server Runtime with JWT authorization',
                RoleArn: cloudwatchMcpRuntimeRole.roleArn,
                AuthorizerConfiguration: {
                    CustomJWTAuthorizer: {
                        AllowedClients: [props.m2mClientId],
                        DiscoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${props.userPoolId}/.well-known/openid-configuration`,
                    }
                },
                AgentRuntimeArtifact: {
                    ContainerConfiguration: {
                        ContainerUri: `${props.cloudwatchMcpRepository.repositoryUri}:latest`
                    }
                },
                NetworkConfiguration: {
                    NetworkMode: 'PUBLIC'
                },
                EnvironmentVariables: {
                    AWS_REGION: this.region,
                    DEPLOYMENT_TIMESTAMP: new Date().toISOString(),
                },
                ProtocolConfiguration: 'MCP',
                LifecycleConfiguration: {},
            }
        });
        cfnCloudWatchMcpRuntime.node.addDependency(cloudwatchMcpRuntimeRole);
        this.cloudwatchMcpRuntimeArn = cfnCloudWatchMcpRuntime.getAtt('AgentRuntimeArn').toString();
        // MCP Runtime endpoint format for AgentCore Gateway targets (from AWS documentation)
        // Format: https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{ENCODED_ARN}/invocations?qualifier=DEFAULT
        // The ARN must be URL-encoded (: → %3A, / → %2F)
        const encodedCloudWatchArn = cdk.Fn.join('', [
            cdk.Fn.select(0, cdk.Fn.split(':', this.cloudwatchMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(1, cdk.Fn.split(':', this.cloudwatchMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(2, cdk.Fn.split(':', this.cloudwatchMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(3, cdk.Fn.split(':', this.cloudwatchMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(4, cdk.Fn.split(':', this.cloudwatchMcpRuntimeArn)),
            '%3A',
            cdk.Fn.join('%2F', cdk.Fn.split('/', cdk.Fn.select(5, cdk.Fn.split(':', this.cloudwatchMcpRuntimeArn)))),
        ]);
        this.cloudwatchMcpRuntimeEndpoint = `https://bedrock-agentcore.${this.region}.amazonaws.com/runtimes/${encodedCloudWatchArn}/invocations?qualifier=DEFAULT`;
        // ========================================
        // CloudTrail MCP Server Runtime
        // ========================================
        // CloudTrail MCP Server Runtime Role
        const cloudtrailMcpRuntimeRole = new iam.Role(this, 'CloudTrailMcpRuntimeRole', {
            roleName: `${this.stackName}-CloudTrailMcpRuntimeRole`,
            assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        });
        // Add common permissions to CloudTrail runtime role
        for (const stmt of commonRuntimePermissions) {
            cloudtrailMcpRuntimeRole.addToPolicy(stmt);
        }
        // ECR image pull for CloudTrail repository
        props.cloudtrailMcpRepository.grantPull(cloudtrailMcpRuntimeRole);
        // Add CloudTrail-specific permissions
        cloudtrailMcpRuntimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'cloudtrail:LookupEvents',
                'cloudtrail:GetTrailStatus',
                'cloudtrail:DescribeTrails',
                'cloudtrail:GetEventSelectors',
                'cloudtrail:ListTrails',
            ],
            resources: ['*'],
        }));
        // CloudTrail MCP Server Runtime
        const cfnCloudTrailMcpRuntime = new cdk.CfnResource(this, 'CloudTrailMcpRuntime', {
            type: 'AWS::BedrockAgentCore::Runtime',
            properties: {
                AgentRuntimeName: 'cloudops_cloudtrail_mcp_jwt_v1',
                Description: 'AWS Labs CloudTrail MCP Server Runtime with JWT authorization',
                RoleArn: cloudtrailMcpRuntimeRole.roleArn,
                AuthorizerConfiguration: {
                    CustomJWTAuthorizer: {
                        AllowedClients: [props.m2mClientId],
                        DiscoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${props.userPoolId}/.well-known/openid-configuration`,
                    }
                },
                AgentRuntimeArtifact: {
                    ContainerConfiguration: {
                        ContainerUri: `${props.cloudtrailMcpRepository.repositoryUri}:latest`
                    }
                },
                NetworkConfiguration: {
                    NetworkMode: 'PUBLIC'
                },
                EnvironmentVariables: {
                    AWS_REGION: this.region,
                    DEPLOYMENT_TIMESTAMP: new Date().toISOString(),
                },
                ProtocolConfiguration: 'MCP',
                LifecycleConfiguration: {},
            }
        });
        cfnCloudTrailMcpRuntime.node.addDependency(cloudtrailMcpRuntimeRole);
        this.cloudtrailMcpRuntimeArn = cfnCloudTrailMcpRuntime.getAtt('AgentRuntimeArn').toString();
        // MCP Runtime endpoint format for AgentCore Gateway targets (from AWS documentation)
        // Format: https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{ENCODED_ARN}/invocations?qualifier=DEFAULT
        // The ARN must be URL-encoded (: → %3A, / → %2F)
        // Reference: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html
        const encodedCloudTrailArn = cdk.Fn.join('', [
            cdk.Fn.select(0, cdk.Fn.split(':', this.cloudtrailMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(1, cdk.Fn.split(':', this.cloudtrailMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(2, cdk.Fn.split(':', this.cloudtrailMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(3, cdk.Fn.split(':', this.cloudtrailMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(4, cdk.Fn.split(':', this.cloudtrailMcpRuntimeArn)),
            '%3A',
            cdk.Fn.join('%2F', cdk.Fn.split('/', cdk.Fn.select(5, cdk.Fn.split(':', this.cloudtrailMcpRuntimeArn)))),
        ]);
        this.cloudtrailMcpRuntimeEndpoint = `https://bedrock-agentcore.${this.region}.amazonaws.com/runtimes/${encodedCloudTrailArn}/invocations?qualifier=DEFAULT`;
        // ========================================
        // DynamoDB EOL Schedules Table (conditional)
        // ========================================
        let eolTableName;
        if (props.eolTableName) {
            // Use existing table name
            eolTableName = props.eolTableName;
        }
        else {
            // Create new DynamoDB table
            const eolTable = new dynamodb.Table(this, 'EolSchedulesTable', {
                tableName: 'aws-eol-schedules',
                partitionKey: { name: 'service', type: dynamodb.AttributeType.STRING },
                sortKey: { name: 'version', type: dynamodb.AttributeType.STRING },
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
                pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
            });
            eolTableName = eolTable.tableName;
        }
        // ========================================
        // Inventory MCP Server Runtime
        // ========================================
        // Inventory MCP Server Runtime Role
        const inventoryMcpRuntimeRole = new iam.Role(this, 'InventoryMcpRuntimeRole', {
            roleName: `${this.stackName}-InventoryMcpRuntimeRole`,
            assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        });
        // Add common permissions to Inventory runtime role
        for (const stmt of commonRuntimePermissions) {
            inventoryMcpRuntimeRole.addToPolicy(stmt);
        }
        // ECR image pull for Inventory repository
        props.inventoryMcpRepository.grantPull(inventoryMcpRuntimeRole);
        // Grant read-only access to EKS, RDS, OpenSearch, ElastiCache, MSK, and EC2 DescribeRegions
        inventoryMcpRuntimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'eks:ListClusters',
                'eks:DescribeCluster',
                'eks:ListNodegroups',
                'eks:DescribeNodegroup',
                'rds:DescribeDBInstances',
                'rds:DescribeDBClusters',
                'rds:DescribeDBEngineVersions',
                'es:ListDomainNames',
                'es:DescribeDomain',
                'es:DescribeDomains',
                'elasticache:DescribeCacheClusters',
                'elasticache:DescribeReplicationGroups',
                'kafka:ListClusters',
                'kafka:ListClustersV2',
                'kafka:DescribeCluster',
                'kafka:DescribeClusterV2',
                'ec2:DescribeRegions',
            ],
            resources: ['*'],
        }));
        // Grant DynamoDB read access on EOL table
        const eolTableArn = `arn:aws:dynamodb:${this.region}:${this.account}:table/${eolTableName}`;
        inventoryMcpRuntimeRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'dynamodb:GetItem',
                'dynamodb:Query',
                'dynamodb:Scan',
            ],
            resources: [eolTableArn],
        }));
        // Inventory MCP Server Runtime
        const cfnInventoryMcpRuntime = new cdk.CfnResource(this, 'InventoryMcpRuntime', {
            type: 'AWS::BedrockAgentCore::Runtime',
            properties: {
                AgentRuntimeName: 'cloudops_inventory_mcp_jwt_v1',
                Description: 'Inventory MCP Server Runtime with JWT authorization',
                RoleArn: inventoryMcpRuntimeRole.roleArn,
                AuthorizerConfiguration: {
                    CustomJWTAuthorizer: {
                        AllowedClients: [props.m2mClientId],
                        DiscoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${props.userPoolId}/.well-known/openid-configuration`,
                    }
                },
                AgentRuntimeArtifact: {
                    ContainerConfiguration: {
                        ContainerUri: `${props.inventoryMcpRepository.repositoryUri}:latest`
                    }
                },
                NetworkConfiguration: {
                    NetworkMode: 'PUBLIC'
                },
                EnvironmentVariables: {
                    AWS_REGION: this.region,
                    EOL_TABLE_NAME: eolTableName,
                    MCP_TRANSPORT: 'streamable-http',
                    DEPLOYMENT_TIMESTAMP: new Date().toISOString(),
                },
                ProtocolConfiguration: 'MCP',
                LifecycleConfiguration: {},
            }
        });
        cfnInventoryMcpRuntime.node.addDependency(inventoryMcpRuntimeRole);
        this.inventoryMcpRuntimeArn = cfnInventoryMcpRuntime.getAtt('AgentRuntimeArn').toString();
        // MCP Runtime endpoint format for AgentCore Gateway targets (from AWS documentation)
        // Format: https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{ENCODED_ARN}/invocations?qualifier=DEFAULT
        // The ARN must be URL-encoded (: → %3A, / → %2F)
        const encodedInventoryArn = cdk.Fn.join('', [
            cdk.Fn.select(0, cdk.Fn.split(':', this.inventoryMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(1, cdk.Fn.split(':', this.inventoryMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(2, cdk.Fn.split(':', this.inventoryMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(3, cdk.Fn.split(':', this.inventoryMcpRuntimeArn)),
            '%3A',
            cdk.Fn.select(4, cdk.Fn.split(':', this.inventoryMcpRuntimeArn)),
            '%3A',
            cdk.Fn.join('%2F', cdk.Fn.split('/', cdk.Fn.select(5, cdk.Fn.split(':', this.inventoryMcpRuntimeArn)))),
        ]);
        this.inventoryMcpRuntimeEndpoint = `https://bedrock-agentcore.${this.region}.amazonaws.com/runtimes/${encodedInventoryArn}/invocations?qualifier=DEFAULT`;
        // ========================================
        // EOL Scraper Lambda Function
        // ========================================
        const eolScraperPath = path.join(__dirname, '../../mcp-servers/inventory/eol-scraper');
        const eolScraperFunction = new lambda.Function(this, 'EolScraperFunction', {
            functionName: `${this.stackName}-EolScraper`,
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'eol_scraper.main.handler',
            code: lambda.Code.fromAsset(eolScraperPath, {
                bundling: {
                    image: lambda.Runtime.PYTHON_3_12.bundlingImage,
                    command: [
                        'bash', '-c',
                        // --no-warn-conflicts: the scraper's deps (boto3/requests/bs4) are
                        // pure-Python and install cleanly into the asset dir; the flag just
                        // suppresses pip's noisy notice about UNRELATED packages that happen
                        // to be present in the surrounding environment.
                        'pip install -r requirements.txt -t /asset-output --no-warn-conflicts && cp -au . /asset-output',
                    ],
                    local: {
                        tryBundle(outputDir) {
                            const { execSync } = require('child_process');
                            try {
                                // `outputDir` is supplied by the CDK asset-bundling framework
                                // (a controlled temp staging path), and `eolScraperPath` is a
                                // fixed compile-time path.join — neither is user-controllable,
                                // so there is no command-injection surface here.
                                // --no-warn-conflicts silences pip's "dependency resolver does
                                // not currently take into account..." notice, which is triggered
                                // by pre-existing packages in the host Python env (strands-agents,
                                // awscli, etc.) — NOT by the scraper's own requirements. The
                                // install into outputDir is isolated and unaffected.
                                // nosemgrep: javascript.lang.security.detect-child-process
                                execSync(`pip install -r ${eolScraperPath}/requirements.txt -t ${outputDir} --quiet --no-warn-conflicts`);
                                // nosemgrep: javascript.lang.security.detect-child-process
                                execSync(`cp -r ${eolScraperPath}/eol_scraper ${outputDir}/`);
                                return true;
                            }
                            catch {
                                return false;
                            }
                        },
                    },
                },
            }),
            memorySize: 512,
            timeout: cdk.Duration.minutes(5),
            environment: {
                EOL_TABLE_NAME: eolTableName,
            },
        });
        // Grant DynamoDB write permissions to Lambda
        eolScraperFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'dynamodb:PutItem',
                'dynamodb:BatchWriteItem',
                'dynamodb:CreateTable',
                'dynamodb:DescribeTable',
            ],
            resources: [eolTableArn],
        }));
        // Grant EKS DescribeClusterVersions permission
        eolScraperFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'eks:DescribeClusterVersions',
                'es:ListVersions',
                'es:ListElasticsearchVersions',
                'elasticache:DescribeCacheEngineVersions',
                'kafka:GetCompatibleKafkaVersions',
                'rds:DescribeDBEngineVersions',
            ],
            resources: ['*'],
        }));
        // EventBridge rule to trigger Lambda daily
        const eolScraperSchedule = new events.Rule(this, 'EolScraperSchedule', {
            ruleName: `${this.stackName}-EolScraperDailySchedule`,
            schedule: events.Schedule.rate(cdk.Duration.days(1)),
        });
        eolScraperSchedule.addTarget(new events_targets.LambdaFunction(eolScraperFunction));
        // ========================================
        // Outputs
        // ========================================
        // The EOL scraper runs on a DAILY schedule, so the EOL table is EMPTY until
        // the first scheduled run. After deployment, invoke it once manually to
        // populate the table immediately (see README "Populate the EOL data").
        new cdk.CfnOutput(this, 'EolScraperFunctionName', {
            value: eolScraperFunction.functionName,
            // NOTE: an Output Description must be a literal string — do NOT interpolate
            // CDK tokens (e.g. functionName/region) here, or CloudFormation renders it
            // as an Fn::Join and rejects the template ("Every Description member must
            // be a string"). The function name is carried in `value`; invoke with:
            //   aws lambda invoke --function-name <value> --region <region> /dev/stdout
            description: 'EOL scraper Lambda name — invoke once after deploy to populate the EOL table (see README).',
            exportName: `${this.stackName}-EolScraperFunctionName`,
        });
        new cdk.CfnOutput(this, 'BillingMcpRuntimeArn', {
            value: this.billingMcpRuntimeArn,
            description: 'Billing MCP Server Runtime ARN',
            exportName: `${this.stackName}-BillingMcpRuntimeArn`,
        });
        new cdk.CfnOutput(this, 'BillingMcpRuntimeEndpoint', {
            value: this.billingMcpRuntimeEndpoint,
            description: 'Billing MCP Server Runtime Endpoint',
            exportName: `${this.stackName}-BillingMcpRuntimeEndpoint`,
        });
        new cdk.CfnOutput(this, 'PricingMcpRuntimeArn', {
            value: this.pricingMcpRuntimeArn,
            description: 'Pricing MCP Server Runtime ARN',
            exportName: `${this.stackName}-PricingMcpRuntimeArn`,
        });
        new cdk.CfnOutput(this, 'PricingMcpRuntimeEndpoint', {
            value: this.pricingMcpRuntimeEndpoint,
            description: 'Pricing MCP Server Runtime Endpoint',
            exportName: `${this.stackName}-PricingMcpRuntimeEndpoint`,
        });
        new cdk.CfnOutput(this, 'CloudWatchMcpRuntimeArnOutput', {
            value: this.cloudwatchMcpRuntimeArn,
            description: 'CloudWatch MCP Server Runtime ARN',
            exportName: `${this.stackName}-CloudWatchMcpRuntimeArn`,
        });
        new cdk.CfnOutput(this, 'CloudWatchMcpRuntimeEndpointOutput', {
            value: this.cloudwatchMcpRuntimeEndpoint,
            description: 'CloudWatch MCP Server Runtime Endpoint',
            exportName: `${this.stackName}-CloudWatchMcpRuntimeEndpoint`,
        });
        new cdk.CfnOutput(this, 'CloudTrailMcpRuntimeArnOutput', {
            value: this.cloudtrailMcpRuntimeArn,
            description: 'CloudTrail MCP Server Runtime ARN',
            exportName: `${this.stackName}-CloudTrailMcpRuntimeArn`,
        });
        new cdk.CfnOutput(this, 'CloudTrailMcpRuntimeEndpointOutput', {
            value: this.cloudtrailMcpRuntimeEndpoint,
            description: 'CloudTrail MCP Server Runtime Endpoint',
            exportName: `${this.stackName}-CloudTrailMcpRuntimeEndpoint`,
        });
        new cdk.CfnOutput(this, 'InventoryMcpRuntimeArn', {
            value: this.inventoryMcpRuntimeArn,
            description: 'Inventory MCP Server Runtime ARN',
            exportName: `${this.stackName}-InventoryMcpRuntimeArn`,
        });
        new cdk.CfnOutput(this, 'InventoryMcpRuntimeEndpoint', {
            value: this.inventoryMcpRuntimeEndpoint,
            description: 'Inventory MCP Server Runtime Endpoint',
            exportName: `${this.stackName}-InventoryMcpRuntimeEndpoint`,
        });
        // ========================================
        // CDK-Nag Suppressions
        // ========================================
        cdk_nag_1.NagSuppressions.addResourceSuppressions(billingMcpRuntimeRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard permissions required for Cost Explorer APIs (account-level services), ECR auth token, CloudWatch, X-Ray',
            },
        ], true);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(pricingMcpRuntimeRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard permissions required for AWS Pricing API (global service), ECR auth token, CloudWatch, X-Ray',
            },
        ], true);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(cloudwatchMcpRuntimeRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard permissions required for CloudWatch and Logs APIs (account-level services), ECR auth token',
            },
        ], true);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(cloudtrailMcpRuntimeRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard permissions required for CloudTrail APIs (account-level services), ECR auth token',
            },
        ], true);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(inventoryMcpRuntimeRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard permissions required for EKS, RDS, OpenSearch, ElastiCache, MSK read-only APIs (account-level services), ECR auth token',
            },
        ], true);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(eolScraperFunction, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard permissions required for EKS DescribeClusterVersions (account-level API)',
            },
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AWSLambdaBasicExecutionRole managed policy is AWS best practice for Lambda functions',
            },
        ], true);
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            {
                id: 'AwsSolutions-L1',
                reason: 'Python 3.14 is the latest Lambda runtime version available',
            },
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AWSLambdaBasicExecutionRole managed policy is AWS best practice for Lambda functions',
            },
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Wildcard permissions required for custom resource Lambda functions',
            },
        ]);
    }
}
exports.MCPRuntimeStack = MCPRuntimeStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXJ1bnRpbWUtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJtY3AtcnVudGltZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMseURBQTJDO0FBRTNDLG1FQUFxRDtBQUNyRCwrREFBaUQ7QUFDakQsK0RBQWlEO0FBQ2pELCtFQUFpRTtBQUNqRSwyQ0FBNkI7QUFFN0IscUNBQTBDO0FBYzFDLE1BQWEsZUFBZ0IsU0FBUSxHQUFHLENBQUMsS0FBSztJQVk1QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTJCO1FBQ25FLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDJDQUEyQztRQUMzQyw2QkFBNkI7UUFDN0IsMkNBQTJDO1FBRTNDLGtDQUFrQztRQUNsQyxNQUFNLHFCQUFxQixHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsdUJBQXVCLEVBQUU7WUFDeEUsUUFBUSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsd0JBQXdCO1lBQ25ELFNBQVMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyxpQ0FBaUMsQ0FBQztTQUN2RSxDQUFDLENBQUM7UUFFSCxrQ0FBa0M7UUFDbEMsTUFBTSxxQkFBcUIsR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLHVCQUF1QixFQUFFO1lBQ3hFLFFBQVEsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLHdCQUF3QjtZQUNuRCxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMsaUNBQWlDLENBQUM7U0FDdkUsQ0FBQyxDQUFDO1FBRUgsa0ZBQWtGO1FBQ2xGLE1BQU0sd0JBQXdCLEdBQTBCO1lBQ3RELG1CQUFtQjtZQUNuQixJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7Z0JBQ3RC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QU0sb0JBQW9CLEdBQUcsR0FBRyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFO1lBQzNDLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLHVCQUF1QixDQUFDLENBQUM7WUFDakUsS0FBSztZQUNMLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLHVCQUF1QixDQUFDLENBQUM7WUFDakUsS0FBSztZQUNMLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLHVCQUF1QixDQUFDLENBQUM7WUFDakUsS0FBSztZQUNMLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLHVCQUF1QixDQUFDLENBQUM7WUFDakUsS0FBSztZQUNMLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLHVCQUF1QixDQUFDLENBQUM7WUFDakUsS0FBSztZQUNMLEdBQUcsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsdUJBQXVCLENBQUMsQ0FBQyxDQUFDLENBQUM7U0FDekcsQ0FBQyxDQUFDO1FBQ0gsSUFBSSxD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VCx5QkFBZSxDQUFDLHVCQUF1QixDQUFDLGtCQUFrQixFQUFFO1lBQzFEO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSxtRkFBbUY7YUFDNUY7WUFDRDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsc0ZBQXNGO2FBQy9GO1NBQ0YsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUVULHlCQUFlLENBQUMsb0JBQW9CLENBQUMsSUFBSSxFQUFFO1lBQ3pDO2dCQUNFLEVBQUUsRUFBRSxpQkFBaUI7Z0JBQ3JCLE1BQU0sRUFBRSw0REFBNEQ7YUFDckU7WUFDRDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsc0ZBQXNGO2FBQy9GO1lBQ0Q7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLG9FQUFvRTthQUM3RTtTQUNGLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQXZ1QkQsMENBdXVCQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGInO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgZXZlbnRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1ldmVudHMnO1xuaW1wb3J0ICogYXMgZXZlbnRzX3RhcmdldHMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWV2ZW50cy10YXJnZXRzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7IE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gJ2Nkay1uYWcnO1xuXG5leHBvcnQgaW50ZXJmYWNlIE1DUFJ1bnRpbWVTdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICBiaWxsaW5nTWNwUmVwb3NpdG9yeTogZWNyLklSZXBvc2l0b3J5O1xuICBwcmljaW5nTWNwUmVwb3NpdG9yeTogZWNyLklSZXBvc2l0b3J5O1xuICBjbG91ZHdhdGNoTWNwUmVwb3NpdG9yeTogZWNyLklSZXBvc2l0b3J5O1xuICBjbG91ZHRyYWlsTWNwUmVwb3NpdG9yeTogZWNyLklSZXBvc2l0b3J5O1xuICBpbnZlbnRvcnlNY3BSZXBvc2l0b3J5OiBlY3IuSVJlcG9zaXRvcnk7XG4gIC8vIEZyb20gQXV0aFN0YWNrIC0gZm9yIEpXVCBhdXRob3JpemF0aW9uIG9uIHJ1bnRpbWVzXG4gIHVzZXJQb29sSWQ6IHN0cmluZztcbiAgbTJtQ2xpZW50SWQ6IHN0cmluZztcbiAgZW9sVGFibGVOYW1lPzogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgTUNQUnVudGltZVN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IGJpbGxpbmdNY3BSdW50aW1lQXJuOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBwcmljaW5nTWNwUnVudGltZUFybjogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgY2xvdWR3YXRjaE1jcFJ1bnRpbWVBcm46IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGNsb3VkdHJhaWxNY3BSdW50aW1lQXJuOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBpbnZlbnRvcnlNY3BSdW50aW1lQXJuOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBiaWxsaW5nTWNwUnVudGltZUVuZHBvaW50OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBwcmljaW5nTWNwUnVudGltZUVuZHBvaW50OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBjbG91ZHdhdGNoTWNwUnVudGltZUVuZHBvaW50OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBjbG91ZHRyYWlsTWNwUnVudGltZUVuZHBvaW50OiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBpbnZlbnRvcnlNY3BSdW50aW1lRW5kcG9pbnQ6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogTUNQUnVudGltZVN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBJQU0gUm9sZXMgZm9yIE1DUCBSdW50aW1lc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIEJpbGxpbmcgTUNQIFNlcnZlciBSdW50aW1lIFJvbGVcbiAgICBjb25zdCBiaWxsaW5nTWNwUnVudGltZVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ0JpbGxpbmdNY3BSdW50aW1lUm9sZScsIHtcbiAgICAgIHJvbGVOYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQmlsbGluZ01jcFJ1bnRpbWVSb2xlYCxcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdiZWRyb2NrLWFnZW50Y29yZS5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG5cbiAgICAvLyBQcmljaW5nIE1DUCBTZXJ2ZXIgUnVudGltZSBSb2xlXG4gICAgY29uc3QgcHJpY2luZ01jcFJ1bnRpbWVSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdQcmljaW5nTWNwUnVudGltZVJvbGUnLCB7XG4gICAgICByb2xlTmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVByaWNpbmdNY3BSdW50aW1lUm9sZWAsXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnYmVkcm9jay1hZ2VudGNvcmUuYW1hem9uYXdzLmNvbScpLFxuICAgIH0pO1xuXG4gICAgLy8gQ29tbW9uIEFnZW50Q29yZSBSdW50aW1lIHBlcm1pc3Npb25zIChFQ1IsIENsb3VkV2F0Y2gsIFgtUmF5LCBCZWRyb2NrLCBHYXRld2F5KVxuICAgIGNvbnN0IGNvbW1vblJ1bnRpbWVQZXJtaXNzaW9uczogaWFtLlBvbGljeVN0YXRlbWVudFtdID0gW1xuICAgICAgLy8gRUNSIHRva2VuIGFjY2Vzc1xuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBzaWQ6ICdFQ1JUb2tlbkFjY2VzcycsXG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuJ10sXG4gICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICB9KSxcbiAgICAgIC8vIENsb3VkV2F0Y2ggTG9nc1xuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnbG9nczpEZXNjcmliZUxvZ0dyb3VwcyddLFxuICAgICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpsb2dzOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpsb2ctZ3JvdXA6KmBdLFxuICAgICAgfSksXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydsb2dzOkRlc2NyaWJlTG9nU3RyZWFtcycsICdsb2dzOkNyZWF0ZUxvZ0dyb3VwJ10sXG4gICAgICAgIHJlc291cmNlczogW2Bhcm46YXdzOmxvZ3M6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OmxvZy1ncm91cDovYXdzL2JlZHJvY2stYWdlbnRjb3JlL3J1bnRpbWVzLypgXSxcbiAgICAgIH0pLFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnbG9nczpDcmVhdGVMb2dTdHJlYW0nLCAnbG9nczpQdXRMb2dFdmVudHMnXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6bG9nczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bG9nLWdyb3VwOi9hd3MvYmVkcm9jay1hZ2VudGNvcmUvcnVudGltZXMvKjpsb2ctc3RyZWFtOipgXSxcbiAgICAgIH0pLFxuICAgICAgLy8gR2F0ZXdheSBpbnZvY2F0aW9uXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIHNpZDogJ0FsbG93R2F0ZXdheUludm9jYXRpb24nLFxuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnYmVkcm9jay1hZ2VudGNvcmU6SW52b2tlR2F0ZXdheSddLFxuICAgICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpiZWRyb2NrLWFnZW50Y29yZToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06Z2F0ZXdheS8qYF0sXG4gICAgICB9KSxcbiAgICBdO1xuXG4gICAgLy8gQWRkIGNvbW1vbiBwZXJtaXNzaW9ucyB0byBib3RoIHJvbGVzXG4gICAgZm9yIChjb25zdCBzdG10IG9mIGNvbW1vblJ1bnRpbWVQZXJtaXNzaW9ucykge1xuICAgICAgYmlsbGluZ01jcFJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KHN0bXQpO1xuICAgICAgcHJpY2luZ01jcFJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KHN0bXQpO1xuICAgIH1cblxuICAgIC8vIEVDUiBpbWFnZSBwdWxsIGZvciBlYWNoIHJvbGUncyBzcGVjaWZpYyByZXBvc2l0b3J5XG4gICAgcHJvcHMuYmlsbGluZ01jcFJlcG9zaXRvcnkuZ3JhbnRQdWxsKGJpbGxpbmdNY3BSdW50aW1lUm9sZSk7XG4gICAgcHJvcHMucHJpY2luZ01jcFJlcG9zaXRvcnkuZ3JhbnRQdWxsKHByaWNpbmdNY3BSdW50aW1lUm9sZSk7XG5cbiAgICAvLyBBZGQgQ29zdCBFeHBsb3JlciBhbmQgYmlsbGluZyBwZXJtaXNzaW9ucyB0byBCaWxsaW5nIE1DUCBSdW50aW1lXG4gICAgYmlsbGluZ01jcFJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2NlOionLFxuICAgICAgICAnYnVkZ2V0czoqJyxcbiAgICAgICAgJ2NvbXB1dGUtb3B0aW1pemVyOionLFxuICAgICAgICAnZnJlZXRpZXI6KicsXG4gICAgICAgICdjb3N0LW9wdGltaXphdGlvbi1odWI6KicsXG4gICAgICAgICdwcmljaW5nOkdldFByb2R1Y3RzJyxcbiAgICAgICAgJ3ByaWNpbmc6R2V0QXR0cmlidXRlVmFsdWVzJyxcbiAgICAgICAgJ3ByaWNpbmc6RGVzY3JpYmVTZXJ2aWNlcycsXG4gICAgICAgICdwcmljaW5nOkxpc3RQcmljZUxpc3RGaWxlcycsXG4gICAgICAgICdwcmljaW5nOkdldFByaWNlTGlzdEZpbGVVcmwnLFxuICAgICAgICAnZWMyOkRlc2NyaWJlSW5zdGFuY2VzJyxcbiAgICAgICAgJ2VjMjpEZXNjcmliZVZvbHVtZXMnLFxuICAgICAgICAnZWMyOkRlc2NyaWJlSW5zdGFuY2VUeXBlcycsXG4gICAgICAgICdlYzI6RGVzY3JpYmVSZWdpb25zJyxcbiAgICAgICAgJ2F1dG9zY2FsaW5nOkRlc2NyaWJlQXV0b1NjYWxpbmdHcm91cHMnLFxuICAgICAgICAnbGFtYmRhOkxpc3RGdW5jdGlvbnMnLFxuICAgICAgICAnbGFtYmRhOkdldEZ1bmN0aW9uJyxcbiAgICAgICAgJ2VjczpMaXN0Q2x1c3RlcnMnLFxuICAgICAgICAnZWNzOkxpc3RTZXJ2aWNlcycsXG4gICAgICAgICdlY3M6RGVzY3JpYmVTZXJ2aWNlcycsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICAvLyBBZGQgUHJpY2luZyBBUEkgcGVybWlzc2lvbnMgdG8gUHJpY2luZyBNQ1AgUnVudGltZVxuICAgIHByaWNpbmdNY3BSdW50aW1lUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdwcmljaW5nOkdldFByb2R1Y3RzJyxcbiAgICAgICAgJ3ByaWNpbmc6R2V0QXR0cmlidXRlVmFsdWVzJyxcbiAgICAgICAgJ3ByaWNpbmc6RGVzY3JpYmVTZXJ2aWNlcycsXG4gICAgICAgICdwcmljaW5nOkxpc3RQcmljZUxpc3RGaWxlcycsXG4gICAgICAgICdwcmljaW5nOkdldFByaWNlTGlzdEZpbGVVcmwnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE1DUCBSdW50aW1lcyB3aXRoIEpXVCBBdXRob3JpemF0aW9uXG4gICAgLy8gR2F0ZXdheSBzZW5kcyBPQXV0aCBCZWFyZXIgdG9rZW5zLCBSdW50aW1lcyB2YWxpZGF0ZSBKV1RcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBCaWxsaW5nIE1DUCBTZXJ2ZXIgUnVudGltZVxuICAgIGNvbnN0IGNmbkJpbGxpbmdNY3BSdW50aW1lID0gbmV3IGNkay5DZm5SZXNvdXJjZSh0aGlzLCAnQmlsbGluZ01jcFJ1bnRpbWUnLCB7XG4gICAgICB0eXBlOiAnQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpSdW50aW1lJyxcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgQWdlbnRSdW50aW1lTmFtZTogJ2Nsb3Vkb3BzX2JpbGxpbmdfbWNwX2p3dF92MScsXG4gICAgICAgIERlc2NyaXB0aW9uOiAnQVdTIExhYnMgQmlsbGluZyBNQ1AgU2VydmVyIFJ1bnRpbWUgd2l0aCBKV1QgYXV0aG9yaXphdGlvbicsXG4gICAgICAgIFJvbGVBcm46IGJpbGxpbmdNY3BSdW50aW1lUm9sZS5yb2xlQXJuLFxuICAgICAgICBBdXRob3JpemVyQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIEN1c3RvbUpXVEF1dGhvcml6ZXI6IHtcbiAgICAgICAgICAgIEFsbG93ZWRDbGllbnRzOiBbcHJvcHMubTJtQ2xpZW50SWRdLFxuICAgICAgICAgICAgRGlzY292ZXJ5VXJsOiBgaHR0cHM6Ly9jb2duaXRvLWlkcC4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tLyR7cHJvcHMudXNlclBvb2xJZH0vLndlbGwta25vd24vb3BlbmlkLWNvbmZpZ3VyYXRpb25gLFxuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAgQWdlbnRSdW50aW1lQXJ0aWZhY3Q6IHtcbiAgICAgICAgICBDb250YWluZXJDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgICBDb250YWluZXJVcmk6IGAke3Byb3BzLmJpbGxpbmdNY3BSZXBvc2l0b3J5LnJlcG9zaXRvcnlVcml9OmxhdGVzdGBcbiAgICAgICAgICB9XG4gICAgICAgIH0sXG4gICAgICAgIE5ldHdvcmtDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgTmV0d29ya01vZGU6ICdQVUJMSUMnXG4gICAgICAgIH0sXG4gICAgICAgIEVudmlyb25tZW50VmFyaWFibGVzOiB7XG4gICAgICAgICAgQVdTX1JFR0lPTjogdGhpcy5yZWdpb24sXG4gICAgICAgICAgREVQTE9ZTUVOVF9USU1FU1RBTVA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgfSxcbiAgICAgICAgUHJvdG9jb2xDb25maWd1cmF0aW9uOiAnTUNQJyxcbiAgICAgICAgTGlmZWN5Y2xlQ29uZmlndXJhdGlvbjoge30sXG4gICAgICB9XG4gICAgfSk7XG4gICAgXG4gICAgY2ZuQmlsbGluZ01jcFJ1bnRpbWUubm9kZS5hZGREZXBlbmRlbmN5KGJpbGxpbmdNY3BSdW50aW1lUm9sZSk7XG5cbiAgICB0aGlzLmJpbGxpbmdNY3BSdW50aW1lQXJuID0gY2ZuQmlsbGluZ01jcFJ1bnRpbWUuZ2V0QXR0KCdBZ2VudFJ1bnRpbWVBcm4nKS50b1N0cmluZygpO1xuICAgIC8vIE1DUCBSdW50aW1lIGVuZHBvaW50IGZvcm1hdCBmb3IgQWdlbnRDb3JlIEdhdGV3YXkgdGFyZ2V0cyAoZnJvbSBBV1MgZG9jdW1lbnRhdGlvbilcbiAgICAvLyBGb3JtYXQ6IGh0dHBzOi8vYmVkcm9jay1hZ2VudGNvcmUue3JlZ2lvbn0uYW1hem9uYXdzLmNvbS9ydW50aW1lcy97RU5DT0RFRF9BUk59L2ludm9jYXRpb25zP3F1YWxpZmllcj1ERUZBVUxUXG4gICAgLy8gVGhlIEFSTiBtdXN0IGJlIFVSTC1lbmNvZGVkICg6IOKGkiAlM0EsIC8g4oaSICUyRilcbiAgICAvLyBSZWZlcmVuY2U6IGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9iZWRyb2NrLWFnZW50Y29yZS9sYXRlc3QvZGV2Z3VpZGUvcnVudGltZS1tY3AuaHRtbFxuICAgIGNvbnN0IGVuY29kZWRCaWxsaW5nQXJuID0gY2RrLkZuLmpvaW4oJycsIFtcbiAgICAgIGNkay5Gbi5zZWxlY3QoMCwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5iaWxsaW5nTWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDEsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuYmlsbGluZ01jcFJ1bnRpbWVBcm4pKSxcbiAgICAgICclM0EnLFxuICAgICAgY2RrLkZuLnNlbGVjdCgyLCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLmJpbGxpbmdNY3BSdW50aW1lQXJuKSksXG4gICAgICAnJTNBJyxcbiAgICAgIGNkay5Gbi5zZWxlY3QoMywgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5iaWxsaW5nTWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDQsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuYmlsbGluZ01jcFJ1bnRpbWVBcm4pKSxcbiAgICAgICclM0EnLFxuICAgICAgY2RrLkZuLmpvaW4oJyUyRicsIGNkay5Gbi5zcGxpdCgnLycsIGNkay5Gbi5zZWxlY3QoNSwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5iaWxsaW5nTWNwUnVudGltZUFybikpKSksXG4gICAgXSk7XG4gICAgdGhpcy5iaWxsaW5nTWNwUnVudGltZUVuZHBvaW50ID0gYGh0dHBzOi8vYmVkcm9jay1hZ2VudGNvcmUuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbS9ydW50aW1lcy8ke2VuY29kZWRCaWxsaW5nQXJufS9pbnZvY2F0aW9ucz9xdWFsaWZpZXI9REVGQVVMVGA7XG5cbiAgICAvLyBQcmljaW5nIE1DUCBTZXJ2ZXIgUnVudGltZVxuICAgIGNvbnN0IGNmblByaWNpbmdNY3BSdW50aW1lID0gbmV3IGNkay5DZm5SZXNvdXJjZSh0aGlzLCAnUHJpY2luZ01jcFJ1bnRpbWUnLCB7XG4gICAgICB0eXBlOiAnQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpSdW50aW1lJyxcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgQWdlbnRSdW50aW1lTmFtZTogJ2Nsb3Vkb3BzX3ByaWNpbmdfbWNwX2p3dF92MScsXG4gICAgICAgIERlc2NyaXB0aW9uOiAnQVdTIExhYnMgUHJpY2luZyBNQ1AgU2VydmVyIFJ1bnRpbWUgd2l0aCBKV1QgYXV0aG9yaXphdGlvbicsXG4gICAgICAgIFJvbGVBcm46IHByaWNpbmdNY3BSdW50aW1lUm9sZS5yb2xlQXJuLFxuICAgICAgICBBdXRob3JpemVyQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIEN1c3RvbUpXVEF1dGhvcml6ZXI6IHtcbiAgICAgICAgICAgIEFsbG93ZWRDbGllbnRzOiBbcHJvcHMubTJtQ2xpZW50SWRdLFxuICAgICAgICAgICAgRGlzY292ZXJ5VXJsOiBgaHR0cHM6Ly9jb2duaXRvLWlkcC4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tLyR7cHJvcHMudXNlclBvb2xJZH0vLndlbGwta25vd24vb3BlbmlkLWNvbmZpZ3VyYXRpb25gLFxuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAgQWdlbnRSdW50aW1lQXJ0aWZhY3Q6IHtcbiAgICAgICAgICBDb250YWluZXJDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgICBDb250YWluZXJVcmk6IGAke3Byb3BzLnByaWNpbmdNY3BSZXBvc2l0b3J5LnJlcG9zaXRvcnlVcml9OmxhdGVzdGBcbiAgICAgICAgICB9XG4gICAgICAgIH0sXG4gICAgICAgIE5ldHdvcmtDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgTmV0d29ya01vZGU6ICdQVUJMSUMnXG4gICAgICAgIH0sXG4gICAgICAgIEVudmlyb25tZW50VmFyaWFibGVzOiB7XG4gICAgICAgICAgQVdTX1JFR0lPTjogdGhpcy5yZWdpb24sXG4gICAgICAgICAgREVQTE9ZTUVOVF9USU1FU1RBTVA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgfSxcbiAgICAgICAgUHJvdG9jb2xDb25maWd1cmF0aW9uOiAnTUNQJyxcbiAgICAgICAgTGlmZWN5Y2xlQ29uZmlndXJhdGlvbjoge30sXG4gICAgICB9XG4gICAgfSk7XG4gICAgXG4gICAgY2ZuUHJpY2luZ01jcFJ1bnRpbWUubm9kZS5hZGREZXBlbmRlbmN5KHByaWNpbmdNY3BSdW50aW1lUm9sZSk7XG5cbiAgICB0aGlzLnByaWNpbmdNY3BSdW50aW1lQXJuID0gY2ZuUHJpY2luZ01jcFJ1bnRpbWUuZ2V0QXR0KCdBZ2VudFJ1bnRpbWVBcm4nKS50b1N0cmluZygpO1xuICAgIC8vIE1DUCBSdW50aW1lIGVuZHBvaW50IGZvcm1hdCBmb3IgQWdlbnRDb3JlIEdhdGV3YXkgdGFyZ2V0cyAoZnJvbSBBV1MgZG9jdW1lbnRhdGlvbilcbiAgICAvLyBGb3JtYXQ6IGh0dHBzOi8vYmVkcm9jay1hZ2VudGNvcmUue3JlZ2lvbn0uYW1hem9uYXdzLmNvbS9ydW50aW1lcy97RU5DT0RFRF9BUk59L2ludm9jYXRpb25zP3F1YWxpZmllcj1ERUZBVUxUXG4gICAgLy8gVGhlIEFSTiBtdXN0IGJlIFVSTC1lbmNvZGVkICg6IOKGkiAlM0EsIC8g4oaSICUyRilcbiAgICAvLyBSZWZlcmVuY2U6IGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9iZWRyb2NrLWFnZW50Y29yZS9sYXRlc3QvZGV2Z3VpZGUvcnVudGltZS1tY3AuaHRtbFxuICAgIGNvbnN0IGVuY29kZWRQcmljaW5nQXJuID0gY2RrLkZuLmpvaW4oJycsIFtcbiAgICAgIGNkay5Gbi5zZWxlY3QoMCwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5wcmljaW5nTWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDEsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMucHJpY2luZ01jcFJ1bnRpbWVBcm4pKSxcbiAgICAgICclM0EnLFxuICAgICAgY2RrLkZuLnNlbGVjdCgyLCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLnByaWNpbmdNY3BSdW50aW1lQXJuKSksXG4gICAgICAnJTNBJyxcbiAgICAgIGNkay5Gbi5zZWxlY3QoMywgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5wcmljaW5nTWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDQsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMucHJpY2luZ01jcFJ1bnRpbWVBcm4pKSxcbiAgICAgICclM0EnLFxuICAgICAgY2RrLkZuLmpvaW4oJyUyRicsIGNkay5Gbi5zcGxpdCgnLycsIGNkay5Gbi5zZWxlY3QoNSwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5wcmljaW5nTWNwUnVudGltZUFybikpKSksXG4gICAgXSk7XG4gICAgdGhpcy5wcmljaW5nTWNwUnVudGltZUVuZHBvaW50ID0gYGh0dHBzOi8vYmVkcm9jay1hZ2VudGNvcmUuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbS9ydW50aW1lcy8ke2VuY29kZWRQcmljaW5nQXJufS9pbnZvY2F0aW9ucz9xdWFsaWZpZXI9REVGQVVMVGA7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ2xvdWRXYXRjaCBNQ1AgU2VydmVyIFJ1bnRpbWVcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBDbG91ZFdhdGNoIE1DUCBTZXJ2ZXIgUnVudGltZSBSb2xlXG4gICAgY29uc3QgY2xvdWR3YXRjaE1jcFJ1bnRpbWVSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdDbG91ZFdhdGNoTWNwUnVudGltZVJvbGUnLCB7XG4gICAgICByb2xlTmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUNsb3VkV2F0Y2hNY3BSdW50aW1lUm9sZWAsXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnYmVkcm9jay1hZ2VudGNvcmUuYW1hem9uYXdzLmNvbScpLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIGNvbW1vbiBwZXJtaXNzaW9ucyB0byBDbG91ZFdhdGNoIHJ1bnRpbWUgcm9sZVxuICAgIGZvciAoY29uc3Qgc3RtdCBvZiBjb21tb25SdW50aW1lUGVybWlzc2lvbnMpIHtcbiAgICAgIGNsb3Vkd2F0Y2hNY3BSdW50aW1lUm9sZS5hZGRUb1BvbGljeShzdG10KTtcbiAgICB9XG5cbiAgICAvLyBFQ1IgaW1hZ2UgcHVsbCBmb3IgQ2xvdWRXYXRjaCByZXBvc2l0b3J5XG4gICAgcHJvcHMuY2xvdWR3YXRjaE1jcFJlcG9zaXRvcnkuZ3JhbnRQdWxsKGNsb3Vkd2F0Y2hNY3BSdW50aW1lUm9sZSk7XG5cbiAgICAvLyBHcmFudCBDbG91ZFdhdGNoIGFuZCBMb2dzIHBlcm1pc3Npb25zXG4gICAgY2xvdWR3YXRjaE1jcFJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2Nsb3Vkd2F0Y2g6KicsXG4gICAgICAgICdsb2dzOionLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuXG4gICAgLy8gQ2xvdWRXYXRjaCBNQ1AgU2VydmVyIFJ1bnRpbWVcbiAgICBjb25zdCBjZm5DbG91ZFdhdGNoTWNwUnVudGltZSA9IG5ldyBjZGsuQ2ZuUmVzb3VyY2UodGhpcywgJ0Nsb3VkV2F0Y2hNY3BSdW50aW1lJywge1xuICAgICAgdHlwZTogJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6UnVudGltZScsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEFnZW50UnVudGltZU5hbWU6ICdjbG91ZG9wc19jbG91ZHdhdGNoX21jcF9qd3RfdjEnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ0FXUyBMYWJzIENsb3VkV2F0Y2ggTUNQIFNlcnZlciBSdW50aW1lIHdpdGggSldUIGF1dGhvcml6YXRpb24nLFxuICAgICAgICBSb2xlQXJuOiBjbG91ZHdhdGNoTWNwUnVudGltZVJvbGUucm9sZUFybixcbiAgICAgICAgQXV0aG9yaXplckNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBDdXN0b21KV1RBdXRob3JpemVyOiB7XG4gICAgICAgICAgICBBbGxvd2VkQ2xpZW50czogW3Byb3BzLm0ybUNsaWVudElkXSxcbiAgICAgICAgICAgIERpc2NvdmVyeVVybDogYGh0dHBzOi8vY29nbml0by1pZHAuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbS8ke3Byb3BzLnVzZXJQb29sSWR9Ly53ZWxsLWtub3duL29wZW5pZC1jb25maWd1cmF0aW9uYCxcbiAgICAgICAgICB9XG4gICAgICAgIH0sXG4gICAgICAgIEFnZW50UnVudGltZUFydGlmYWN0OiB7XG4gICAgICAgICAgQ29udGFpbmVyQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgICAgQ29udGFpbmVyVXJpOiBgJHtwcm9wcy5jbG91ZHdhdGNoTWNwUmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpfTpsYXRlc3RgXG4gICAgICAgICAgfVxuICAgICAgICB9LFxuICAgICAgICBOZXR3b3JrQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIE5ldHdvcmtNb2RlOiAnUFVCTElDJ1xuICAgICAgICB9LFxuICAgICAgICBFbnZpcm9ubWVudFZhcmlhYmxlczoge1xuICAgICAgICAgIEFXU19SRUdJT046IHRoaXMucmVnaW9uLFxuICAgICAgICAgIERFUExPWU1FTlRfVElNRVNUQU1QOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgIH0sXG4gICAgICAgIFByb3RvY29sQ29uZmlndXJhdGlvbjogJ01DUCcsXG4gICAgICAgIExpZmVjeWNsZUNvbmZpZ3VyYXRpb246IHt9LFxuICAgICAgfVxuICAgIH0pO1xuXG4gICAgY2ZuQ2xvdWRXYXRjaE1jcFJ1bnRpbWUubm9kZS5hZGREZXBlbmRlbmN5KGNsb3Vkd2F0Y2hNY3BSdW50aW1lUm9sZSk7XG5cbiAgICB0aGlzLmNsb3Vkd2F0Y2hNY3BSdW50aW1lQXJuID0gY2ZuQ2xvdWRXYXRjaE1jcFJ1bnRpbWUuZ2V0QXR0KCdBZ2VudFJ1bnRpbWVBcm4nKS50b1N0cmluZygpO1xuICAgIC8vIE1DUCBSdW50aW1lIGVuZHBvaW50IGZvcm1hdCBmb3IgQWdlbnRDb3JlIEdhdGV3YXkgdGFyZ2V0cyAoZnJvbSBBV1MgZG9jdW1lbnRhdGlvbilcbiAgICAvLyBGb3JtYXQ6IGh0dHBzOi8vYmVkcm9jay1hZ2VudGNvcmUue3JlZ2lvbn0uYW1hem9uYXdzLmNvbS9ydW50aW1lcy97RU5DT0RFRF9BUk59L2ludm9jYXRpb25zP3F1YWxpZmllcj1ERUZBVUxUXG4gICAgLy8gVGhlIEFSTiBtdXN0IGJlIFVSTC1lbmNvZGVkICg6IOKGkiAlM0EsIC8g4oaSICUyRilcbiAgICBjb25zdCBlbmNvZGVkQ2xvdWRXYXRjaEFybiA9IGNkay5Gbi5qb2luKCcnLCBbXG4gICAgICBjZGsuRm4uc2VsZWN0KDAsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuY2xvdWR3YXRjaE1jcFJ1bnRpbWVBcm4pKSxcbiAgICAgICclM0EnLFxuICAgICAgY2RrLkZuLnNlbGVjdCgxLCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLmNsb3Vkd2F0Y2hNY3BSdW50aW1lQXJuKSksXG4gICAgICAnJTNBJyxcbiAgICAgIGNkay5Gbi5zZWxlY3QoMiwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5jbG91ZHdhdGNoTWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDMsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuY2xvdWR3YXRjaE1jcFJ1bnRpbWVBcm4pKSxcbiAgICAgICclM0EnLFxuICAgICAgY2RrLkZuLnNlbGVjdCg0LCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLmNsb3Vkd2F0Y2hNY3BSdW50aW1lQXJuKSksXG4gICAgICAnJTNBJyxcbiAgICAgIGNkay5Gbi5qb2luKCclMkYnLCBjZGsuRm4uc3BsaXQoJy8nLCBjZGsuRm4uc2VsZWN0KDUsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuY2xvdWR3YXRjaE1jcFJ1bnRpbWVBcm4pKSkpLFxuICAgIF0pO1xuICAgIHRoaXMuY2xvdWR3YXRjaE1jcFJ1bnRpbWVFbmRwb2ludCA9IGBodHRwczovL2JlZHJvY2stYWdlbnRjb3JlLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb20vcnVudGltZXMvJHtlbmNvZGVkQ2xvdWRXYXRjaEFybn0vaW52b2NhdGlvbnM/cXVhbGlmaWVyPURFRkFVTFRgO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENsb3VkVHJhaWwgTUNQIFNlcnZlciBSdW50aW1lXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgLy8gQ2xvdWRUcmFpbCBNQ1AgU2VydmVyIFJ1bnRpbWUgUm9sZVxuICAgIGNvbnN0IGNsb3VkdHJhaWxNY3BSdW50aW1lUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnQ2xvdWRUcmFpbE1jcFJ1bnRpbWVSb2xlJywge1xuICAgICAgcm9sZU5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1DbG91ZFRyYWlsTWNwUnVudGltZVJvbGVgLFxuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2JlZHJvY2stYWdlbnRjb3JlLmFtYXpvbmF3cy5jb20nKSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBjb21tb24gcGVybWlzc2lvbnMgdG8gQ2xvdWRUcmFpbCBydW50aW1lIHJvbGVcbiAgICBmb3IgKGNvbnN0IHN0bXQgb2YgY29tbW9uUnVudGltZVBlcm1pc3Npb25zKSB7XG4gICAgICBjbG91ZHRyYWlsTWNwUnVudGltZVJvbGUuYWRkVG9Qb2xpY3koc3RtdCk7XG4gICAgfVxuXG4gICAgLy8gRUNSIGltYWdlIHB1bGwgZm9yIENsb3VkVHJhaWwgcmVwb3NpdG9yeVxuICAgIHByb3BzLmNsb3VkdHJhaWxNY3BSZXBvc2l0b3J5LmdyYW50UHVsbChjbG91ZHRyYWlsTWNwUnVudGltZVJvbGUpO1xuXG4gICAgLy8gQWRkIENsb3VkVHJhaWwtc3BlY2lmaWMgcGVybWlzc2lvbnNcbiAgICBjbG91ZHRyYWlsTWNwUnVudGltZVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnY2xvdWR0cmFpbDpMb29rdXBFdmVudHMnLFxuICAgICAgICAnY2xvdWR0cmFpbDpHZXRUcmFpbFN0YXR1cycsXG4gICAgICAgICdjbG91ZHRyYWlsOkRlc2NyaWJlVHJhaWxzJyxcbiAgICAgICAgJ2Nsb3VkdHJhaWw6R2V0RXZlbnRTZWxlY3RvcnMnLFxuICAgICAgICAnY2xvdWR0cmFpbDpMaXN0VHJhaWxzJyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcblxuICAgIC8vIENsb3VkVHJhaWwgTUNQIFNlcnZlciBSdW50aW1lXG4gICAgY29uc3QgY2ZuQ2xvdWRUcmFpbE1jcFJ1bnRpbWUgPSBuZXcgY2RrLkNmblJlc291cmNlKHRoaXMsICdDbG91ZFRyYWlsTWNwUnVudGltZScsIHtcbiAgICAgIHR5cGU6ICdBV1M6OkJlZHJvY2tBZ2VudENvcmU6OlJ1bnRpbWUnLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBBZ2VudFJ1bnRpbWVOYW1lOiAnY2xvdWRvcHNfY2xvdWR0cmFpbF9tY3Bfand0X3YxJyxcbiAgICAgICAgRGVzY3JpcHRpb246ICdBV1MgTGFicyBDbG91ZFRyYWlsIE1DUCBTZXJ2ZXIgUnVudGltZSB3aXRoIEpXVCBhdXRob3JpemF0aW9uJyxcbiAgICAgICAgUm9sZUFybjogY2xvdWR0cmFpbE1jcFJ1bnRpbWVSb2xlLnJvbGVBcm4sXG4gICAgICAgIEF1dGhvcml6ZXJDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgQ3VzdG9tSldUQXV0aG9yaXplcjoge1xuICAgICAgICAgICAgQWxsb3dlZENsaWVudHM6IFtwcm9wcy5tMm1DbGllbnRJZF0sXG4gICAgICAgICAgICBEaXNjb3ZlcnlVcmw6IGBodHRwczovL2NvZ25pdG8taWRwLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb20vJHtwcm9wcy51c2VyUG9vbElkfS8ud2VsbC1rbm93bi9vcGVuaWQtY29uZmlndXJhdGlvbmAsXG4gICAgICAgICAgfVxuICAgICAgICB9LFxuICAgICAgICBBZ2VudFJ1bnRpbWVBcnRpZmFjdDoge1xuICAgICAgICAgIENvbnRhaW5lckNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICAgIENvbnRhaW5lclVyaTogYCR7cHJvcHMuY2xvdWR0cmFpbE1jcFJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaX06bGF0ZXN0YFxuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAgTmV0d29ya0NvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBOZXR3b3JrTW9kZTogJ1BVQkxJQydcbiAgICAgICAgfSxcbiAgICAgICAgRW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcbiAgICAgICAgICBBV1NfUkVHSU9OOiB0aGlzLnJlZ2lvbixcbiAgICAgICAgICBERVBMT1lNRU5UX1RJTUVTVEFNUDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICB9LFxuICAgICAgICBQcm90b2NvbENvbmZpZ3VyYXRpb246ICdNQ1AnLFxuICAgICAgICBMaWZlY3ljbGVDb25maWd1cmF0aW9uOiB7fSxcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGNmbkNsb3VkVHJhaWxNY3BSdW50aW1lLm5vZGUuYWRkRGVwZW5kZW5jeShjbG91ZHRyYWlsTWNwUnVudGltZVJvbGUpO1xuXG4gICAgdGhpcy5jbG91ZHRyYWlsTWNwUnVudGltZUFybiA9IGNmbkNsb3VkVHJhaWxNY3BSdW50aW1lLmdldEF0dCgnQWdlbnRSdW50aW1lQXJuJykudG9TdHJpbmcoKTtcbiAgICAvLyBNQ1AgUnVudGltZSBlbmRwb2ludCBmb3JtYXQgZm9yIEFnZW50Q29yZSBHYXRld2F5IHRhcmdldHMgKGZyb20gQVdTIGRvY3VtZW50YXRpb24pXG4gICAgLy8gRm9ybWF0OiBodHRwczovL2JlZHJvY2stYWdlbnRjb3JlLntyZWdpb259LmFtYXpvbmF3cy5jb20vcnVudGltZXMve0VOQ09ERURfQVJOfS9pbnZvY2F0aW9ucz9xdWFsaWZpZXI9REVGQVVMVFxuICAgIC8vIFRoZSBBUk4gbXVzdCBiZSBVUkwtZW5jb2RlZCAoOiDihpIgJTNBLCAvIOKGkiAlMkYpXG4gICAgLy8gUmVmZXJlbmNlOiBodHRwczovL2RvY3MuYXdzLmFtYXpvbi5jb20vYmVkcm9jay1hZ2VudGNvcmUvbGF0ZXN0L2Rldmd1aWRlL3J1bnRpbWUtbWNwLmh0bWxcbiAgICBjb25zdCBlbmNvZGVkQ2xvdWRUcmFpbEFybiA9IGNkay5Gbi5qb2luKCcnLCBbXG4gICAgICBjZGsuRm4uc2VsZWN0KDAsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuY2xvdWR0cmFpbE1jcFJ1bnRpbWVBcm4pKSxcbiAgICAgICclM0EnLFxuICAgICAgY2RrLkZuLnNlbGVjdCgxLCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLmNsb3VkdHJhaWxNY3BSdW50aW1lQXJuKSksXG4gICAgICAnJTNBJyxcbiAgICAgIGNkay5Gbi5zZWxlY3QoMiwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5jbG91ZHRyYWlsTWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDMsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuY2xvdWR0cmFpbE1jcFJ1bnRpbWVBcm4pKSxcbiAgICAgICclM0EnLFxuICAgICAgY2RrLkZuLnNlbGVjdCg0LCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLmNsb3VkdHJhaWxNY3BSdW50aW1lQXJuKSksXG4gICAgICAnJTNBJyxcbiAgICAgIGNkay5Gbi5qb2luKCclMkYnLCBjZGsuRm4uc3BsaXQoJy8nLCBjZGsuRm4uc2VsZWN0KDUsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuY2xvdWR0cmFpbE1jcFJ1bnRpbWVBcm4pKSkpLFxuICAgIF0pO1xuICAgIHRoaXMuY2xvdWR0cmFpbE1jcFJ1bnRpbWVFbmRwb2ludCA9IGBodHRwczovL2JlZHJvY2stYWdlbnRjb3JlLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb20vcnVudGltZXMvJHtlbmNvZGVkQ2xvdWRUcmFpbEFybn0vaW52b2NhdGlvbnM/cXVhbGlmaWVyPURFRkFVTFRgO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIER5bmFtb0RCIEVPTCBTY2hlZHVsZXMgVGFibGUgKGNvbmRpdGlvbmFsKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBsZXQgZW9sVGFibGVOYW1lOiBzdHJpbmc7XG4gICAgaWYgKHByb3BzLmVvbFRhYmxlTmFtZSkge1xuICAgICAgLy8gVXNlIGV4aXN0aW5nIHRhYmxlIG5hbWVcbiAgICAgIGVvbFRhYmxlTmFtZSA9IHByb3BzLmVvbFRhYmxlTmFtZTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gQ3JlYXRlIG5ldyBEeW5hbW9EQiB0YWJsZVxuICAgICAgY29uc3QgZW9sVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ0VvbFNjaGVkdWxlc1RhYmxlJywge1xuICAgICAgICB0YWJsZU5hbWU6ICdhd3MtZW9sLXNjaGVkdWxlcycsXG4gICAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAnc2VydmljZScsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHNvcnRLZXk6IHsgbmFtZTogJ3ZlcnNpb24nLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjogeyBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogdHJ1ZSB9LFxuICAgICAgfSk7XG4gICAgICBlb2xUYWJsZU5hbWUgPSBlb2xUYWJsZS50YWJsZU5hbWU7XG4gICAgfVxuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEludmVudG9yeSBNQ1AgU2VydmVyIFJ1bnRpbWVcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBJbnZlbnRvcnkgTUNQIFNlcnZlciBSdW50aW1lIFJvbGVcbiAgICBjb25zdCBpbnZlbnRvcnlNY3BSdW50aW1lUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnSW52ZW50b3J5TWNwUnVudGltZVJvbGUnLCB7XG4gICAgICByb2xlTmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUludmVudG9yeU1jcFJ1bnRpbWVSb2xlYCxcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdiZWRyb2NrLWFnZW50Y29yZS5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgY29tbW9uIHBlcm1pc3Npb25zIHRvIEludmVudG9yeSBydW50aW1lIHJvbGVcbiAgICBmb3IgKGNvbnN0IHN0bXQgb2YgY29tbW9uUnVudGltZVBlcm1pc3Npb25zKSB7XG4gICAgICBpbnZlbnRvcnlNY3BSdW50aW1lUm9sZS5hZGRUb1BvbGljeShzdG10KTtcbiAgICB9XG5cbiAgICAvLyBFQ1IgaW1hZ2UgcHVsbCBmb3IgSW52ZW50b3J5IHJlcG9zaXRvcnlcbiAgICBwcm9wcy5pbnZlbnRvcnlNY3BSZXBvc2l0b3J5LmdyYW50UHVsbChpbnZlbnRvcnlNY3BSdW50aW1lUm9sZSk7XG5cbiAgICAvLyBHcmFudCByZWFkLW9ubHkgYWNjZXNzIHRvIEVLUywgUkRTLCBPcGVuU2VhcmNoLCBFbGFzdGlDYWNoZSwgTVNLLCBhbmQgRUMyIERlc2NyaWJlUmVnaW9uc1xuICAgIGludmVudG9yeU1jcFJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2VrczpMaXN0Q2x1c3RlcnMnLFxuICAgICAgICAnZWtzOkRlc2NyaWJlQ2x1c3RlcicsXG4gICAgICAgICdla3M6TGlzdE5vZGVncm91cHMnLFxuICAgICAgICAnZWtzOkRlc2NyaWJlTm9kZWdyb3VwJyxcbiAgICAgICAgJ3JkczpEZXNjcmliZURCSW5zdGFuY2VzJyxcbiAgICAgICAgJ3JkczpEZXNjcmliZURCQ2x1c3RlcnMnLFxuICAgICAgICAncmRzOkRlc2NyaWJlREJFbmdpbmVWZXJzaW9ucycsXG4gICAgICAgICdlczpMaXN0RG9tYWluTmFtZXMnLFxuICAgICAgICAnZXM6RGVzY3JpYmVEb21haW4nLFxuICAgICAgICAnZXM6RGVzY3JpYmVEb21haW5zJyxcbiAgICAgICAgJ2VsYXN0aWNhY2hlOkRlc2NyaWJlQ2FjaGVDbHVzdGVycycsXG4gICAgICAgICdlbGFzdGljYWNoZTpEZXNjcmliZVJlcGxpY2F0aW9uR3JvdXBzJyxcbiAgICAgICAgJ2thZmthOkxpc3RDbHVzdGVycycsXG4gICAgICAgICdrYWZrYTpMaXN0Q2x1c3RlcnNWMicsXG4gICAgICAgICdrYWZrYTpEZXNjcmliZUNsdXN0ZXInLFxuICAgICAgICAna2Fma2E6RGVzY3JpYmVDbHVzdGVyVjInLFxuICAgICAgICAnZWMyOkRlc2NyaWJlUmVnaW9ucycsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICAvLyBHcmFudCBEeW5hbW9EQiByZWFkIGFjY2VzcyBvbiBFT0wgdGFibGVcbiAgICBjb25zdCBlb2xUYWJsZUFybiA9IGBhcm46YXdzOmR5bmFtb2RiOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTp0YWJsZS8ke2VvbFRhYmxlTmFtZX1gO1xuICAgIGludmVudG9yeU1jcFJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2R5bmFtb2RiOkdldEl0ZW0nLFxuICAgICAgICAnZHluYW1vZGI6UXVlcnknLFxuICAgICAgICAnZHluYW1vZGI6U2NhbicsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbZW9sVGFibGVBcm5dLFxuICAgIH0pKTtcblxuICAgIC8vIEludmVudG9yeSBNQ1AgU2VydmVyIFJ1bnRpbWVcbiAgICBjb25zdCBjZm5JbnZlbnRvcnlNY3BSdW50aW1lID0gbmV3IGNkay5DZm5SZXNvdXJjZSh0aGlzLCAnSW52ZW50b3J5TWNwUnVudGltZScsIHtcbiAgICAgIHR5cGU6ICdBV1M6OkJlZHJvY2tBZ2VudENvcmU6OlJ1bnRpbWUnLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBBZ2VudFJ1bnRpbWVOYW1lOiAnY2xvdWRvcHNfaW52ZW50b3J5X21jcF9qd3RfdjEnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ0ludmVudG9yeSBNQ1AgU2VydmVyIFJ1bnRpbWUgd2l0aCBKV1QgYXV0aG9yaXphdGlvbicsXG4gICAgICAgIFJvbGVBcm46IGludmVudG9yeU1jcFJ1bnRpbWVSb2xlLnJvbGVBcm4sXG4gICAgICAgIEF1dGhvcml6ZXJDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgQ3VzdG9tSldUQXV0aG9yaXplcjoge1xuICAgICAgICAgICAgQWxsb3dlZENsaWVudHM6IFtwcm9wcy5tMm1DbGllbnRJZF0sXG4gICAgICAgICAgICBEaXNjb3ZlcnlVcmw6IGBodHRwczovL2NvZ25pdG8taWRwLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb20vJHtwcm9wcy51c2VyUG9vbElkfS8ud2VsbC1rbm93bi9vcGVuaWQtY29uZmlndXJhdGlvbmAsXG4gICAgICAgICAgfVxuICAgICAgICB9LFxuICAgICAgICBBZ2VudFJ1bnRpbWVBcnRpZmFjdDoge1xuICAgICAgICAgIENvbnRhaW5lckNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICAgIENvbnRhaW5lclVyaTogYCR7cHJvcHMuaW52ZW50b3J5TWNwUmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpfTpsYXRlc3RgXG4gICAgICAgICAgfVxuICAgICAgICB9LFxuICAgICAgICBOZXR3b3JrQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIE5ldHdvcmtNb2RlOiAnUFVCTElDJ1xuICAgICAgICB9LFxuICAgICAgICBFbnZpcm9ubWVudFZhcmlhYmxlczoge1xuICAgICAgICAgIEFXU19SRUdJT046IHRoaXMucmVnaW9uLFxuICAgICAgICAgIEVPTF9UQUJMRV9OQU1FOiBlb2xUYWJsZU5hbWUsXG4gICAgICAgICAgTUNQX1RSQU5TUE9SVDogJ3N0cmVhbWFibGUtaHR0cCcsXG4gICAgICAgICAgREVQTE9ZTUVOVF9USU1FU1RBTVA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgfSxcbiAgICAgICAgUHJvdG9jb2xDb25maWd1cmF0aW9uOiAnTUNQJyxcbiAgICAgICAgTGlmZWN5Y2xlQ29uZmlndXJhdGlvbjoge30sXG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBjZm5JbnZlbnRvcnlNY3BSdW50aW1lLm5vZGUuYWRkRGVwZW5kZW5jeShpbnZlbnRvcnlNY3BSdW50aW1lUm9sZSk7XG5cbiAgICB0aGlzLmludmVudG9yeU1jcFJ1bnRpbWVBcm4gPSBjZm5JbnZlbnRvcnlNY3BSdW50aW1lLmdldEF0dCgnQWdlbnRSdW50aW1lQXJuJykudG9TdHJpbmcoKTtcbiAgICAvLyBNQ1AgUnVudGltZSBlbmRwb2ludCBmb3JtYXQgZm9yIEFnZW50Q29yZSBHYXRld2F5IHRhcmdldHMgKGZyb20gQVdTIGRvY3VtZW50YXRpb24pXG4gICAgLy8gRm9ybWF0OiBodHRwczovL2JlZHJvY2stYWdlbnRjb3JlLntyZWdpb259LmFtYXpvbmF3cy5jb20vcnVudGltZXMve0VOQ09ERURfQVJOfS9pbnZvY2F0aW9ucz9xdWFsaWZpZXI9REVGQVVMVFxuICAgIC8vIFRoZSBBUk4gbXVzdCBiZSBVUkwtZW5jb2RlZCAoOiDihpIgJTNBLCAvIOKGkiAlMkYpXG4gICAgY29uc3QgZW5jb2RlZEludmVudG9yeUFybiA9IGNkay5Gbi5qb2luKCcnLCBbXG4gICAgICBjZGsuRm4uc2VsZWN0KDAsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuaW52ZW50b3J5TWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDEsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuaW52ZW50b3J5TWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDIsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuaW52ZW50b3J5TWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDMsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuaW52ZW50b3J5TWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDQsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuaW52ZW50b3J5TWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uam9pbignJTJGJywgY2RrLkZuLnNwbGl0KCcvJywgY2RrLkZuLnNlbGVjdCg1LCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLmludmVudG9yeU1jcFJ1bnRpbWVBcm4pKSkpLFxuICAgIF0pO1xuICAgIHRoaXMuaW52ZW50b3J5TWNwUnVudGltZUVuZHBvaW50ID0gYGh0dHBzOi8vYmVkcm9jay1hZ2VudGNvcmUuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbS9ydW50aW1lcy8ke2VuY29kZWRJbnZlbnRvcnlBcm59L2ludm9jYXRpb25zP3F1YWxpZmllcj1ERUZBVUxUYDtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBFT0wgU2NyYXBlciBMYW1iZGEgRnVuY3Rpb25cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBjb25zdCBlb2xTY3JhcGVyUGF0aCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi8uLi9tY3Atc2VydmVycy9pbnZlbnRvcnkvZW9sLXNjcmFwZXInKTtcbiAgICBjb25zdCBlb2xTY3JhcGVyRnVuY3Rpb24gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdFb2xTY3JhcGVyRnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Fb2xTY3JhcGVyYCxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEyLFxuICAgICAgaGFuZGxlcjogJ2VvbF9zY3JhcGVyLm1haW4uaGFuZGxlcicsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoZW9sU2NyYXBlclBhdGgsIHtcbiAgICAgICAgYnVuZGxpbmc6IHtcbiAgICAgICAgICBpbWFnZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTIuYnVuZGxpbmdJbWFnZSxcbiAgICAgICAgICBjb21tYW5kOiBbXG4gICAgICAgICAgICAnYmFzaCcsICctYycsXG4gICAgICAgICAgICAvLyAtLW5vLXdhcm4tY29uZmxpY3RzOiB0aGUgc2NyYXBlcidzIGRlcHMgKGJvdG8zL3JlcXVlc3RzL2JzNCkgYXJlXG4gICAgICAgICAgICAvLyBwdXJlLVB5dGhvbiBhbmQgaW5zdGFsbCBjbGVhbmx5IGludG8gdGhlIGFzc2V0IGRpcjsgdGhlIGZsYWcganVzdFxuICAgICAgICAgICAgLy8gc3VwcHJlc3NlcyBwaXAncyBub2lzeSBub3RpY2UgYWJvdXQgVU5SRUxBVEVEIHBhY2thZ2VzIHRoYXQgaGFwcGVuXG4gICAgICAgICAgICAvLyB0byBiZSBwcmVzZW50IGluIHRoZSBzdXJyb3VuZGluZyBlbnZpcm9ubWVudC5cbiAgICAgICAgICAgICdwaXAgaW5zdGFsbCAtciByZXF1aXJlbWVudHMudHh0IC10IC9hc3NldC1vdXRwdXQgLS1uby13YXJuLWNvbmZsaWN0cyAmJiBjcCAtYXUgLiAvYXNzZXQtb3V0cHV0JyxcbiAgICAgICAgICBdLFxuICAgICAgICAgIGxvY2FsOiB7XG4gICAgICAgICAgICB0cnlCdW5kbGUob3V0cHV0RGlyOiBzdHJpbmcpIHtcbiAgICAgICAgICAgICAgY29uc3QgeyBleGVjU3luYyB9ID0gcmVxdWlyZSgnY2hpbGRfcHJvY2VzcycpO1xuICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIC8vIGBvdXRwdXREaXJgIGlzIHN1cHBsaWVkIGJ5IHRoZSBDREsgYXNzZXQtYnVuZGxpbmcgZnJhbWV3b3JrXG4gICAgICAgICAgICAgICAgLy8gKGEgY29udHJvbGxlZCB0ZW1wIHN0YWdpbmcgcGF0aCksIGFuZCBgZW9sU2NyYXBlclBhdGhgIGlzIGFcbiAgICAgICAgICAgICAgICAvLyBmaXhlZCBjb21waWxlLXRpbWUgcGF0aC5qb2luIOKAlCBuZWl0aGVyIGlzIHVzZXItY29udHJvbGxhYmxlLFxuICAgICAgICAgICAgICAgIC8vIHNvIHRoZXJlIGlzIG5vIGNvbW1hbmQtaW5qZWN0aW9uIHN1cmZhY2UgaGVyZS5cbiAgICAgICAgICAgICAgICAvLyAtLW5vLXdhcm4tY29uZmxpY3RzIHNpbGVuY2VzIHBpcCdzIFwiZGVwZW5kZW5jeSByZXNvbHZlciBkb2VzXG4gICAgICAgICAgICAgICAgLy8gbm90IGN1cnJlbnRseSB0YWtlIGludG8gYWNjb3VudC4uLlwiIG5vdGljZSwgd2hpY2ggaXMgdHJpZ2dlcmVkXG4gICAgICAgICAgICAgICAgLy8gYnkgcHJlLWV4aXN0aW5nIHBhY2thZ2VzIGluIHRoZSBob3N0IFB5dGhvbiBlbnYgKHN0cmFuZHMtYWdlbnRzLFxuICAgICAgICAgICAgICAgIC8vIGF3c2NsaSwgZXRjLikg4oCUIE5PVCBieSB0aGUgc2NyYXBlcidzIG93biByZXF1aXJlbWVudHMuIFRoZVxuICAgICAgICAgICAgICAgIC8vIGluc3RhbGwgaW50byBvdXRwdXREaXIgaXMgaXNvbGF0ZWQgYW5kIHVuYWZmZWN0ZWQuXG4gICAgICAgICAgICAgICAgLy8gbm9zZW1ncmVwOiBqYXZhc2NyaXB0Lmxhbmcuc2VjdXJpdHkuZGV0ZWN0LWNoaWxkLXByb2Nlc3NcbiAgICAgICAgICAgICAgICBleGVjU3luYyhgcGlwIGluc3RhbGwgLXIgJHtlb2xTY3JhcGVyUGF0aH0vcmVxdWlyZW1lbnRzLnR4dCAtdCAke291dHB1dERpcn0gLS1xdWlldCAtLW5vLXdhcm4tY29uZmxpY3RzYCk7XG4gICAgICAgICAgICAgICAgLy8gbm9zZW1ncmVwOiBqYXZhc2NyaXB0Lmxhbmcuc2VjdXJpdHkuZGV0ZWN0LWNoaWxkLXByb2Nlc3NcbiAgICAgICAgICAgICAgICBleGVjU3luYyhgY3AgLXIgJHtlb2xTY3JhcGVyUGF0aH0vZW9sX3NjcmFwZXIgJHtvdXRwdXREaXJ9L2ApO1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgbWVtb3J5U2l6ZTogNTEyLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBFT0xfVEFCTEVfTkFNRTogZW9sVGFibGVOYW1lLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEdyYW50IER5bmFtb0RCIHdyaXRlIHBlcm1pc3Npb25zIHRvIExhbWJkYVxuICAgIGVvbFNjcmFwZXJGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnZHluYW1vZGI6UHV0SXRlbScsXG4gICAgICAgICdkeW5hbW9kYjpCYXRjaFdyaXRlSXRlbScsXG4gICAgICAgICdkeW5hbW9kYjpDcmVhdGVUYWJsZScsXG4gICAgICAgICdkeW5hbW9kYjpEZXNjcmliZVRhYmxlJyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtlb2xUYWJsZUFybl0sXG4gICAgfSkpO1xuXG4gICAgLy8gR3JhbnQgRUtTIERlc2NyaWJlQ2x1c3RlclZlcnNpb25zIHBlcm1pc3Npb25cbiAgICBlb2xTY3JhcGVyRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2VrczpEZXNjcmliZUNsdXN0ZXJWZXJzaW9ucycsXG4gICAgICAgICdlczpMaXN0VmVyc2lvbnMnLFxuICAgICAgICAnZXM6TGlzdEVsYXN0aWNzZWFyY2hWZXJzaW9ucycsXG4gICAgICAgICdlbGFzdGljYWNoZTpEZXNjcmliZUNhY2hlRW5naW5lVmVyc2lvbnMnLFxuICAgICAgICAna2Fma2E6R2V0Q29tcGF0aWJsZUthZmthVmVyc2lvbnMnLFxuICAgICAgICAncmRzOkRlc2NyaWJlREJFbmdpbmVWZXJzaW9ucycsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICAvLyBFdmVudEJyaWRnZSBydWxlIHRvIHRyaWdnZXIgTGFtYmRhIGRhaWx5XG4gICAgY29uc3QgZW9sU2NyYXBlclNjaGVkdWxlID0gbmV3IGV2ZW50cy5SdWxlKHRoaXMsICdFb2xTY3JhcGVyU2NoZWR1bGUnLCB7XG4gICAgICBydWxlTmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUVvbFNjcmFwZXJEYWlseVNjaGVkdWxlYCxcbiAgICAgIHNjaGVkdWxlOiBldmVudHMuU2NoZWR1bGUucmF0ZShjZGsuRHVyYXRpb24uZGF5cygxKSksXG4gICAgfSk7XG4gICAgZW9sU2NyYXBlclNjaGVkdWxlLmFkZFRhcmdldChuZXcgZXZlbnRzX3RhcmdldHMuTGFtYmRhRnVuY3Rpb24oZW9sU2NyYXBlckZ1bmN0aW9uKSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIFRoZSBFT0wgc2NyYXBlciBydW5zIG9uIGEgREFJTFkgc2NoZWR1bGUsIHNvIHRoZSBFT0wgdGFibGUgaXMgRU1QVFkgdW50aWxcbiAgICAvLyB0aGUgZmlyc3Qgc2NoZWR1bGVkIHJ1bi4gQWZ0ZXIgZGVwbG95bWVudCwgaW52b2tlIGl0IG9uY2UgbWFudWFsbHkgdG9cbiAgICAvLyBwb3B1bGF0ZSB0aGUgdGFibGUgaW1tZWRpYXRlbHkgKHNlZSBSRUFETUUgXCJQb3B1bGF0ZSB0aGUgRU9MIGRhdGFcIikuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0VvbFNjcmFwZXJGdW5jdGlvbk5hbWUnLCB7XG4gICAgICB2YWx1ZTogZW9sU2NyYXBlckZ1bmN0aW9uLmZ1bmN0aW9uTmFtZSxcbiAgICAgIC8vIE5PVEU6IGFuIE91dHB1dCBEZXNjcmlwdGlvbiBtdXN0IGJlIGEgbGl0ZXJhbCBzdHJpbmcg4oCUIGRvIE5PVCBpbnRlcnBvbGF0ZVxuICAgICAgLy8gQ0RLIHRva2VucyAoZS5nLiBmdW5jdGlvbk5hbWUvcmVnaW9uKSBoZXJlLCBvciBDbG91ZEZvcm1hdGlvbiByZW5kZXJzIGl0XG4gICAgICAvLyBhcyBhbiBGbjo6Sm9pbiBhbmQgcmVqZWN0cyB0aGUgdGVtcGxhdGUgKFwiRXZlcnkgRGVzY3JpcHRpb24gbWVtYmVyIG11c3RcbiAgICAgIC8vIGJlIGEgc3RyaW5nXCIpLiBUaGUgZnVuY3Rpb24gbmFtZSBpcyBjYXJyaWVkIGluIGB2YWx1ZWA7IGludm9rZSB3aXRoOlxuICAgICAgLy8gICBhd3MgbGFtYmRhIGludm9rZSAtLWZ1bmN0aW9uLW5hbWUgPHZhbHVlPiAtLXJlZ2lvbiA8cmVnaW9uPiAvZGV2L3N0ZG91dFxuICAgICAgZGVzY3JpcHRpb246ICdFT0wgc2NyYXBlciBMYW1iZGEgbmFtZSDigJQgaW52b2tlIG9uY2UgYWZ0ZXIgZGVwbG95IHRvIHBvcHVsYXRlIHRoZSBFT0wgdGFibGUgKHNlZSBSRUFETUUpLicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tRW9sU2NyYXBlckZ1bmN0aW9uTmFtZWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQmlsbGluZ01jcFJ1bnRpbWVBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5iaWxsaW5nTWNwUnVudGltZUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQmlsbGluZyBNQ1AgU2VydmVyIFJ1bnRpbWUgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1CaWxsaW5nTWNwUnVudGltZUFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQmlsbGluZ01jcFJ1bnRpbWVFbmRwb2ludCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmJpbGxpbmdNY3BSdW50aW1lRW5kcG9pbnQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0JpbGxpbmcgTUNQIFNlcnZlciBSdW50aW1lIEVuZHBvaW50JyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1CaWxsaW5nTWNwUnVudGltZUVuZHBvaW50YCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdQcmljaW5nTWNwUnVudGltZUFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnByaWNpbmdNY3BSdW50aW1lQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdQcmljaW5nIE1DUCBTZXJ2ZXIgUnVudGltZSBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVByaWNpbmdNY3BSdW50aW1lQXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdQcmljaW5nTWNwUnVudGltZUVuZHBvaW50Jywge1xuICAgICAgdmFsdWU6IHRoaXMucHJpY2luZ01jcFJ1bnRpbWVFbmRwb2ludCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUHJpY2luZyBNQ1AgU2VydmVyIFJ1bnRpbWUgRW5kcG9pbnQnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVByaWNpbmdNY3BSdW50aW1lRW5kcG9pbnRgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Nsb3VkV2F0Y2hNY3BSdW50aW1lQXJuT3V0cHV0Jywge1xuICAgICAgdmFsdWU6IHRoaXMuY2xvdWR3YXRjaE1jcFJ1bnRpbWVBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0Nsb3VkV2F0Y2ggTUNQIFNlcnZlciBSdW50aW1lIEFSTicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQ2xvdWRXYXRjaE1jcFJ1bnRpbWVBcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Nsb3VkV2F0Y2hNY3BSdW50aW1lRW5kcG9pbnRPdXRwdXQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5jbG91ZHdhdGNoTWNwUnVudGltZUVuZHBvaW50LFxuICAgICAgZGVzY3JpcHRpb246ICdDbG91ZFdhdGNoIE1DUCBTZXJ2ZXIgUnVudGltZSBFbmRwb2ludCcsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQ2xvdWRXYXRjaE1jcFJ1bnRpbWVFbmRwb2ludGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2xvdWRUcmFpbE1jcFJ1bnRpbWVBcm5PdXRwdXQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5jbG91ZHRyYWlsTWNwUnVudGltZUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ2xvdWRUcmFpbCBNQ1AgU2VydmVyIFJ1bnRpbWUgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1DbG91ZFRyYWlsTWNwUnVudGltZUFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2xvdWRUcmFpbE1jcFJ1bnRpbWVFbmRwb2ludE91dHB1dCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmNsb3VkdHJhaWxNY3BSdW50aW1lRW5kcG9pbnQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0Nsb3VkVHJhaWwgTUNQIFNlcnZlciBSdW50aW1lIEVuZHBvaW50JyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1DbG91ZFRyYWlsTWNwUnVudGltZUVuZHBvaW50YCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdJbnZlbnRvcnlNY3BSdW50aW1lQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMuaW52ZW50b3J5TWNwUnVudGltZUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnSW52ZW50b3J5IE1DUCBTZXJ2ZXIgUnVudGltZSBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUludmVudG9yeU1jcFJ1bnRpbWVBcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0ludmVudG9yeU1jcFJ1bnRpbWVFbmRwb2ludCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmludmVudG9yeU1jcFJ1bnRpbWVFbmRwb2ludCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnSW52ZW50b3J5IE1DUCBTZXJ2ZXIgUnVudGltZSBFbmRwb2ludCcsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tSW52ZW50b3J5TWNwUnVudGltZUVuZHBvaW50YCxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDREstTmFnIFN1cHByZXNzaW9uc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhiaWxsaW5nTWNwUnVudGltZVJvbGUsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBDb3N0IEV4cGxvcmVyIEFQSXMgKGFjY291bnQtbGV2ZWwgc2VydmljZXMpLCBFQ1IgYXV0aCB0b2tlbiwgQ2xvdWRXYXRjaCwgWC1SYXknLFxuICAgICAgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhwcmljaW5nTWNwUnVudGltZVJvbGUsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBBV1MgUHJpY2luZyBBUEkgKGdsb2JhbCBzZXJ2aWNlKSwgRUNSIGF1dGggdG9rZW4sIENsb3VkV2F0Y2gsIFgtUmF5JyxcbiAgICAgIH0sXG4gICAgXSwgdHJ1ZSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMoY2xvdWR3YXRjaE1jcFJ1bnRpbWVSb2xlLCBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxuICAgICAgICByZWFzb246ICdXaWxkY2FyZCBwZXJtaXNzaW9ucyByZXF1aXJlZCBmb3IgQ2xvdWRXYXRjaCBhbmQgTG9ncyBBUElzIChhY2NvdW50LWxldmVsIHNlcnZpY2VzKSwgRUNSIGF1dGggdG9rZW4nLFxuICAgICAgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhjbG91ZHRyYWlsTWNwUnVudGltZVJvbGUsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBDbG91ZFRyYWlsIEFQSXMgKGFjY291bnQtbGV2ZWwgc2VydmljZXMpLCBFQ1IgYXV0aCB0b2tlbicsXG4gICAgICB9LFxuICAgIF0sIHRydWUpO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKGludmVudG9yeU1jcFJ1bnRpbWVSb2xlLCBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxuICAgICAgICByZWFzb246ICdXaWxkY2FyZCBwZXJtaXNzaW9ucyByZXF1aXJlZCBmb3IgRUtTLCBSRFMsIE9wZW5TZWFyY2gsIEVsYXN0aUNhY2hlLCBNU0sgcmVhZC1vbmx5IEFQSXMgKGFjY291bnQtbGV2ZWwgc2VydmljZXMpLCBFQ1IgYXV0aCB0b2tlbicsXG4gICAgICB9LFxuICAgIF0sIHRydWUpO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKGVvbFNjcmFwZXJGdW5jdGlvbiwgW1xuICAgICAge1xuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JyxcbiAgICAgICAgcmVhc29uOiAnV2lsZGNhcmQgcGVybWlzc2lvbnMgcmVxdWlyZWQgZm9yIEVLUyBEZXNjcmliZUNsdXN0ZXJWZXJzaW9ucyAoYWNjb3VudC1sZXZlbCBBUEkpJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTQnLFxuICAgICAgICByZWFzb246ICdBV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUgbWFuYWdlZCBwb2xpY3kgaXMgQVdTIGJlc3QgcHJhY3RpY2UgZm9yIExhbWJkYSBmdW5jdGlvbnMnLFxuICAgICAgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRTdGFja1N1cHByZXNzaW9ucyh0aGlzLCBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUwxJyxcbiAgICAgICAgcmVhc29uOiAnUHl0aG9uIDMuMTQgaXMgdGhlIGxhdGVzdCBMYW1iZGEgcnVudGltZSB2ZXJzaW9uIGF2YWlsYWJsZScsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU00JyxcbiAgICAgICAgcmVhc29uOiAnQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlIG1hbmFnZWQgcG9saWN5IGlzIEFXUyBiZXN0IHByYWN0aWNlIGZvciBMYW1iZGEgZnVuY3Rpb25zJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxuICAgICAgICByZWFzb246ICdXaWxkY2FyZCBwZXJtaXNzaW9ucyByZXF1aXJlZCBmb3IgY3VzdG9tIHJlc291cmNlIExhbWJkYSBmdW5jdGlvbnMnLFxuICAgICAgfSxcbiAgICBdKTtcbiAgfVxufVxuIl19