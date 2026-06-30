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
            assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        });
        // Pricing MCP Server Runtime Role
        const pricingMcpRuntimeRole = new iam.Role(this, 'PricingMcpRuntimeRole', {
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
        // Statement 1 — Cost-management & pricing APIs. These services
        // (Cost Explorer, Budgets, Compute Optimizer, Free Tier, Cost Optimization
        // Hub, Pricing) are account/region-global and do NOT support resource-level
        // ARNs, so Resource: '*' is required. All actions are read-only despite the
        // `:*` form (these services expose no mutating actions the server uses).
        billingMcpRuntimeRole.addToPolicy(new iam.PolicyStatement({
            sid: 'CostManagementAndPricingReadOnly',
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
            ],
            resources: ['*'],
        }));
        // Statement 2 — Resource-inventory Describe/List actions used by the
        // upstream Billing MCP server's rightsizing / Compute Optimizer features to
        // correlate cost data with EC2/EBS/Auto Scaling/Lambda/ECS resources. These
        // are all read-only Describe*/List*/Get* actions; the AWS Describe/List APIs
        // they call are region-scoped and do not accept resource-level ARNs, so
        // Resource: '*' is required. They are required for the billing tools to
        // function — removing them breaks rightsizing/optimization lookups.
        billingMcpRuntimeRole.addToPolicy(new iam.PolicyStatement({
            sid: 'ResourceInventoryReadOnly',
            effect: iam.Effect.ALLOW,
            actions: [
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
                            // Use execFileSync with an explicit argument vector (NOT a shell
                            // string) so no shell is spawned and there is no command-injection
                            // surface — inputs are CDK-controlled build paths regardless.
                            // --no-warn-conflicts silences pip's "dependency resolver does not
                            // currently take into account..." notice (triggered by unrelated
                            // packages in the host Python env, not the scraper's deps).
                            const { execFileSync } = require('child_process');
                            const fs = require('fs');
                            try {
                                execFileSync('python3', [
                                    '-m', 'pip', 'install',
                                    '-r', `${eolScraperPath}/requirements.txt`,
                                    '-t', outputDir,
                                    '--quiet', '--no-warn-conflicts',
                                ], { stdio: 'ignore' });
                                // Copy the package source with the Node fs API — no subprocess.
                                fs.cpSync(`${eolScraperPath}/eol_scraper`, `${outputDir}/eol_scraper`, { recursive: true });
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXJ1bnRpbWUtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJtY3AtcnVudGltZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMseURBQTJDO0FBRTNDLG1FQUFxRDtBQUNyRCwrREFBaUQ7QUFDakQsK0RBQWlEO0FBQ2pELCtFQUFpRTtBQUNqRSwyQ0FBNkI7QUFFN0IscUNBQTBDO0FBYzFDLE1BQWEsZUFBZ0IsU0FBUSxHQUFHLENBQUMsS0FBSztJQVk1QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTJCO1FBQ25FLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDJDQUEyQztRQUMzQyw2QkFBNkI7UUFDN0IsMkNBQTJDO1FBRTNDLGtDQUFrQztRQUNsQyxNQUFNLHFCQUFxQixHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsdUJBQXVCLEVBQUU7WUFDeEUsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLGlDQUFpQyxDQUFDO1NBQ3ZFLENBQUMsQ0FBQztRQUVILGtDQUFrQztRQUNsQyxNQUFNLHFCQUFxQixHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsdUJBQXVCLEVBQUU7WUFDeEUsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLGlDQUFpQyxDQUFDO1NBQ3ZFLENBQUMsQ0FBQztRQUVILGtGQUFrRjtRQUNsRixNQUFNLHdCQUF3QixHQUEwQjtZQUN0RCxtQkFBbUI7WUFDbkIsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO2dCQUN0QixHQUFHLEVBQUUsZ0JBQWdCO2dCQUNyQixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO2dCQUN4QixPQUFPLEVBQUUsQ0FBQywyQkFB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QzVGLE1BQU0sb0JBQW9CLEdBQUcsR0FBRyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFO1lBQzNDLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLHVCQUF1QixDQUFDLENBQUM7WUFDakUsS0FBSztZQUNMLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLHVCQUF1QixDQUFDLENBQUM7WUFDakUsS0FBSztZQUNMLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLHVCQUF1QixDQUFDLENBQUM7WUFDakUsS0FBSztZQUNMLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLHVCQUF1QixDQUFDLENBQUM7WUFDakUsS0FBSztZQUNMLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLHVCQUF1QixDQUFDLENBQUM7WUFDakUsS0FBSztZQUNMLEdBQUcsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsdUJBQXVCLENBQUMsQ0FBQyxDQUFDLENBQUM7U0FDekcsQ0FBQyxDQUFDO1FBQ0gs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TUFBTSxtQkFBbUIsR0FBRyxHQUFHLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQUU7WUFDMUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsc0JBQXNCLENBQUMsQ0FBQztZQUNoRSxLQUFLO1lBQ0wsR0FBRyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsc0JBQXNCLENBQUMsQ0FBQztZQUNoRSxLQUFLO1lBQ0wsR0FBRyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsc0JBQXNCLENBQUMsQ0FBQztZQUNoRSxLQUFLO1lBQ0wsR0FBRyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsc0JBQXNCLENBQUMsQ0FBQztZQUNoRSxLQUFLO1lBQ0wsR0FBRyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsc0JBQXNCLENBQUMsQ0FBQztZQUNoRSxLQUFLO1lBQ0wsR0FBRyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxzQkFBc0IsQ0FBQyxDQUFDLENBQUMsQ0FBQztTQUN4RyxDQUFDLENBQUM7UUFDSCxJQUFJ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QUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLHFHQUFxRzthQUM5RztTQUNGLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFFVCx5QkFBZSxDQUFDLHVCQUF1QixDQUFDLHdCQUF3QixFQUFFO1lBQ2hFO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSw0RkFBNEY7YUFDckc7U0FDRixFQUFFLElBQUksQ0FBQyxDQUFDO1FBRVQseUJBQWUsQ0FBQyx1QkFBdUIsQ0FBQyx1QkFBdUIsRUFBRTtZQUMvRDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsa0lBQWtJO2FBQzNJO1NBQ0YsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUVULHlCQUFlLENBQUMsdUJBQXVCLENBQUMsa0JBQWtCLEVBQUU7WUFDMUQ7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLG1GQUFtRjthQUM1RjtZQUNEO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSxzRkFBc0Y7YUFDL0Y7U0FDRixFQUFFLElBQUksQ0FBQyxDQUFDO1FBRVQseUJBQWUsQ0FBQyxvQkFBb0IsQ0FBQyxJQUFJLEVBQUU7WUFDekM7Z0JBQ0UsRUFBRSxFQUFFLGlCQUFpQjtnQkFDckIsTUFBTSxFQUFFLDREQUE0RDthQUNyRTtZQUNEO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSxzRkFBc0Y7YUFDL0Y7WUFDRDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsb0VBQW9FO2FBQzdFO1NBQ0YsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBN3ZCRCwwQ0E2dkJDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGVjciBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNyJztcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgKiBhcyBldmVudHMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWV2ZW50cyc7XG5pbXBvcnQgKiBhcyBldmVudHNfdGFyZ2V0cyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZXZlbnRzLXRhcmdldHMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0IHsgTmFnU3VwcHJlc3Npb25zIH0gZnJvbSAnY2RrLW5hZyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgTUNQUnVudGltZVN0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIGJpbGxpbmdNY3BSZXBvc2l0b3J5OiBlY3IuSVJlcG9zaXRvcnk7XG4gIHByaWNpbmdNY3BSZXBvc2l0b3J5OiBlY3IuSVJlcG9zaXRvcnk7XG4gIGNsb3Vkd2F0Y2hNY3BSZXBvc2l0b3J5OiBlY3IuSVJlcG9zaXRvcnk7XG4gIGNsb3VkdHJhaWxNY3BSZXBvc2l0b3J5OiBlY3IuSVJlcG9zaXRvcnk7XG4gIGludmVudG9yeU1jcFJlcG9zaXRvcnk6IGVjci5JUmVwb3NpdG9yeTtcbiAgLy8gRnJvbSBBdXRoU3RhY2sgLSBmb3IgSldUIGF1dGhvcml6YXRpb24gb24gcnVudGltZXNcbiAgdXNlclBvb2xJZDogc3RyaW5nO1xuICBtMm1DbGllbnRJZDogc3RyaW5nO1xuICBlb2xUYWJsZU5hbWU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBNQ1BSdW50aW1lU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgYmlsbGluZ01jcFJ1bnRpbWVBcm46IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IHByaWNpbmdNY3BSdW50aW1lQXJuOiBzdHJpbmc7XG4gIHB1YmxpYyByZWFkb25seSBjbG91ZHdhdGNoTWNwUnVudGltZUFybjogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgY2xvdWR0cmFpbE1jcFJ1bnRpbWVBcm46IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGludmVudG9yeU1jcFJ1bnRpbWVBcm46IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGJpbGxpbmdNY3BSdW50aW1lRW5kcG9pbnQ6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IHByaWNpbmdNY3BSdW50aW1lRW5kcG9pbnQ6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGNsb3Vkd2F0Y2hNY3BSdW50aW1lRW5kcG9pbnQ6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGNsb3VkdHJhaWxNY3BSdW50aW1lRW5kcG9pbnQ6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGludmVudG9yeU1jcFJ1bnRpbWVFbmRwb2ludDogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBNQ1BSdW50aW1lU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIElBTSBSb2xlcyBmb3IgTUNQIFJ1bnRpbWVzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgLy8gQmlsbGluZyBNQ1AgU2VydmVyIFJ1bnRpbWUgUm9sZVxuICAgIGNvbnN0IGJpbGxpbmdNY3BSdW50aW1lUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnQmlsbGluZ01jcFJ1bnRpbWVSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2JlZHJvY2stYWdlbnRjb3JlLmFtYXpvbmF3cy5jb20nKSxcbiAgICB9KTtcblxuICAgIC8vIFByaWNpbmcgTUNQIFNlcnZlciBSdW50aW1lIFJvbGVcbiAgICBjb25zdCBwcmljaW5nTWNwUnVudGltZVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1ByaWNpbmdNY3BSdW50aW1lUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdiZWRyb2NrLWFnZW50Y29yZS5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG5cbiAgICAvLyBDb21tb24gQWdlbnRDb3JlIFJ1bnRpbWUgcGVybWlzc2lvbnMgKEVDUiwgQ2xvdWRXYXRjaCwgWC1SYXksIEJlZHJvY2ssIEdhdGV3YXkpXG4gICAgY29uc3QgY29tbW9uUnVudGltZVBlcm1pc3Npb25zOiBpYW0uUG9saWN5U3RhdGVtZW50W10gPSBbXG4gICAgICAvLyBFQ1IgdG9rZW4gYWNjZXNzXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIHNpZDogJ0VDUlRva2VuQWNjZXNzJyxcbiAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICBhY3Rpb25zOiBbJ2VjcjpHZXRBdXRob3JpemF0aW9uVG9rZW4nXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgIH0pLFxuICAgICAgLy8gQ2xvdWRXYXRjaCBMb2dzXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydsb2dzOkRlc2NyaWJlTG9nR3JvdXBzJ10sXG4gICAgICAgIHJlc291cmNlczogW2Bhcm46YXdzOmxvZ3M6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OmxvZy1ncm91cDoqYF0sXG4gICAgICB9KSxcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICBhY3Rpb25zOiBbJ2xvZ3M6RGVzY3JpYmVMb2dTdHJlYW1zJywgJ2xvZ3M6Q3JlYXRlTG9nR3JvdXAnXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6bG9nczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bG9nLWdyb3VwOi9hd3MvYmVkcm9jay1hZ2VudGNvcmUvcnVudGltZXMvKmBdLFxuICAgICAgfSksXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsICdsb2dzOlB1dExvZ0V2ZW50cyddLFxuICAgICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpsb2dzOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpsb2ctZ3JvdXA6L2F3cy9iZWRyb2NrLWFnZW50Y29yZS9ydW50aW1lcy8qOmxvZy1zdHJlYW06KmBdLFxuICAgICAgfSksXG4gICAgICAvLyBHYXRld2F5IGludm9jYXRpb25cbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgc2lkOiAnQWxsb3dHYXRld2F5SW52b2NhdGlvbicsXG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydiZWRyb2NrLWFnZW50Y29yZTpJbnZva2VHYXRld2F5J10sXG4gICAgICAgIHJlc291cmNlczogW2Bhcm46YXdzOmJlZHJvY2stYWdlbnRjb3JlOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpnYXRld2F5LypgXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICAvLyBBZGQgY29tbW9uIHBlcm1pc3Npb25zIHRvIGJvdGggcm9sZXNcbiAgICBmb3IgKGNvbnN0IHN0bXQgb2YgY29tbW9uUnVudGltZVBlcm1pc3Npb25zKSB7XG4gICAgICBiaWxsaW5nTWNwUnVudGltZVJvbGUuYWRkVG9Qb2xpY3koc3RtdCk7XG4gICAgICBwcmljaW5nTWNwUnVudGltZVJvbGUuYWRkVG9Qb2xpY3koc3RtdCk7XG4gICAgfVxuXG4gICAgLy8gRUNSIGltYWdlIHB1bGwgZm9yIGVhY2ggcm9sZSdzIHNwZWNpZmljIHJlcG9zaXRvcnlcbiAgICBwcm9wcy5iaWxsaW5nTWNwUmVwb3NpdG9yeS5ncmFudFB1bGwoYmlsbGluZ01jcFJ1bnRpbWVSb2xlKTtcbiAgICBwcm9wcy5wcmljaW5nTWNwUmVwb3NpdG9yeS5ncmFudFB1bGwocHJpY2luZ01jcFJ1bnRpbWVSb2xlKTtcblxuICAgIC8vIEFkZCBDb3N0IEV4cGxvcmVyIGFuZCBiaWxsaW5nIHBlcm1pc3Npb25zIHRvIEJpbGxpbmcgTUNQIFJ1bnRpbWVcbiAgICAvLyBTdGF0ZW1lbnQgMSDigJQgQ29zdC1tYW5hZ2VtZW50ICYgcHJpY2luZyBBUElzLiBUaGVzZSBzZXJ2aWNlc1xuICAgIC8vIChDb3N0IEV4cGxvcmVyLCBCdWRnZXRzLCBDb21wdXRlIE9wdGltaXplciwgRnJlZSBUaWVyLCBDb3N0IE9wdGltaXphdGlvblxuICAgIC8vIEh1YiwgUHJpY2luZykgYXJlIGFjY291bnQvcmVnaW9uLWdsb2JhbCBhbmQgZG8gTk9UIHN1cHBvcnQgcmVzb3VyY2UtbGV2ZWxcbiAgICAvLyBBUk5zLCBzbyBSZXNvdXJjZTogJyonIGlzIHJlcXVpcmVkLiBBbGwgYWN0aW9ucyBhcmUgcmVhZC1vbmx5IGRlc3BpdGUgdGhlXG4gICAgLy8gYDoqYCBmb3JtICh0aGVzZSBzZXJ2aWNlcyBleHBvc2Ugbm8gbXV0YXRpbmcgYWN0aW9ucyB0aGUgc2VydmVyIHVzZXMpLlxuICAgIGJpbGxpbmdNY3BSdW50aW1lUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBzaWQ6ICdDb3N0TWFuYWdlbWVudEFuZFByaWNpbmdSZWFkT25seScsXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdjZToqJyxcbiAgICAgICAgJ2J1ZGdldHM6KicsXG4gICAgICAgICdjb21wdXRlLW9wdGltaXplcjoqJyxcbiAgICAgICAgJ2ZyZWV0aWVyOionLFxuICAgICAgICAnY29zdC1vcHRpbWl6YXRpb24taHViOionLFxuICAgICAgICAncHJpY2luZzpHZXRQcm9kdWN0cycsXG4gICAgICAgICdwcmljaW5nOkdldEF0dHJpYnV0ZVZhbHVlcycsXG4gICAgICAgICdwcmljaW5nOkRlc2NyaWJlU2VydmljZXMnLFxuICAgICAgICAncHJpY2luZzpMaXN0UHJpY2VMaXN0RmlsZXMnLFxuICAgICAgICAncHJpY2luZzpHZXRQcmljZUxpc3RGaWxlVXJsJyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcblxuICAgIC8vIFN0YXRlbWVudCAyIOKAlCBSZXNvdXJjZS1pbnZlbnRvcnkgRGVzY3JpYmUvTGlzdCBhY3Rpb25zIHVzZWQgYnkgdGhlXG4gICAgLy8gdXBzdHJlYW0gQmlsbGluZyBNQ1Agc2VydmVyJ3MgcmlnaHRzaXppbmcgLyBDb21wdXRlIE9wdGltaXplciBmZWF0dXJlcyB0b1xuICAgIC8vIGNvcnJlbGF0ZSBjb3N0IGRhdGEgd2l0aCBFQzIvRUJTL0F1dG8gU2NhbGluZy9MYW1iZGEvRUNTIHJlc291cmNlcy4gVGhlc2VcbiAgICAvLyBhcmUgYWxsIHJlYWQtb25seSBEZXNjcmliZSovTGlzdCovR2V0KiBhY3Rpb25zOyB0aGUgQVdTIERlc2NyaWJlL0xpc3QgQVBJc1xuICAgIC8vIHRoZXkgY2FsbCBhcmUgcmVnaW9uLXNjb3BlZCBhbmQgZG8gbm90IGFjY2VwdCByZXNvdXJjZS1sZXZlbCBBUk5zLCBzb1xuICAgIC8vIFJlc291cmNlOiAnKicgaXMgcmVxdWlyZWQuIFRoZXkgYXJlIHJlcXVpcmVkIGZvciB0aGUgYmlsbGluZyB0b29scyB0b1xuICAgIC8vIGZ1bmN0aW9uIOKAlCByZW1vdmluZyB0aGVtIGJyZWFrcyByaWdodHNpemluZy9vcHRpbWl6YXRpb24gbG9va3Vwcy5cbiAgICBiaWxsaW5nTWNwUnVudGltZVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgc2lkOiAnUmVzb3VyY2VJbnZlbnRvcnlSZWFkT25seScsXG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdlYzI6RGVzY3JpYmVJbnN0YW5jZXMnLFxuICAgICAgICAnZWMyOkRlc2NyaWJlVm9sdW1lcycsXG4gICAgICAgICdlYzI6RGVzY3JpYmVJbnN0YW5jZVR5cGVzJyxcbiAgICAgICAgJ2VjMjpEZXNjcmliZVJlZ2lvbnMnLFxuICAgICAgICAnYXV0b3NjYWxpbmc6RGVzY3JpYmVBdXRvU2NhbGluZ0dyb3VwcycsXG4gICAgICAgICdsYW1iZGE6TGlzdEZ1bmN0aW9ucycsXG4gICAgICAgICdsYW1iZGE6R2V0RnVuY3Rpb24nLFxuICAgICAgICAnZWNzOkxpc3RDbHVzdGVycycsXG4gICAgICAgICdlY3M6TGlzdFNlcnZpY2VzJyxcbiAgICAgICAgJ2VjczpEZXNjcmliZVNlcnZpY2VzJyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgIH0pKTtcblxuICAgIC8vIEFkZCBQcmljaW5nIEFQSSBwZXJtaXNzaW9ucyB0byBQcmljaW5nIE1DUCBSdW50aW1lXG4gICAgcHJpY2luZ01jcFJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ3ByaWNpbmc6R2V0UHJvZHVjdHMnLFxuICAgICAgICAncHJpY2luZzpHZXRBdHRyaWJ1dGVWYWx1ZXMnLFxuICAgICAgICAncHJpY2luZzpEZXNjcmliZVNlcnZpY2VzJyxcbiAgICAgICAgJ3ByaWNpbmc6TGlzdFByaWNlTGlzdEZpbGVzJyxcbiAgICAgICAgJ3ByaWNpbmc6R2V0UHJpY2VMaXN0RmlsZVVybCcsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTUNQIFJ1bnRpbWVzIHdpdGggSldUIEF1dGhvcml6YXRpb25cbiAgICAvLyBHYXRld2F5IHNlbmRzIE9BdXRoIEJlYXJlciB0b2tlbnMsIFJ1bnRpbWVzIHZhbGlkYXRlIEpXVFxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIEJpbGxpbmcgTUNQIFNlcnZlciBSdW50aW1lXG4gICAgY29uc3QgY2ZuQmlsbGluZ01jcFJ1bnRpbWUgPSBuZXcgY2RrLkNmblJlc291cmNlKHRoaXMsICdCaWxsaW5nTWNwUnVudGltZScsIHtcbiAgICAgIHR5cGU6ICdBV1M6OkJlZHJvY2tBZ2VudENvcmU6OlJ1bnRpbWUnLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBBZ2VudFJ1bnRpbWVOYW1lOiAnY2xvdWRvcHNfYmlsbGluZ19tY3Bfand0X3YxJyxcbiAgICAgICAgRGVzY3JpcHRpb246ICdBV1MgTGFicyBCaWxsaW5nIE1DUCBTZXJ2ZXIgUnVudGltZSB3aXRoIEpXVCBhdXRob3JpemF0aW9uJyxcbiAgICAgICAgUm9sZUFybjogYmlsbGluZ01jcFJ1bnRpbWVSb2xlLnJvbGVBcm4sXG4gICAgICAgIEF1dGhvcml6ZXJDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgQ3VzdG9tSldUQXV0aG9yaXplcjoge1xuICAgICAgICAgICAgQWxsb3dlZENsaWVudHM6IFtwcm9wcy5tMm1DbGllbnRJZF0sXG4gICAgICAgICAgICBEaXNjb3ZlcnlVcmw6IGBodHRwczovL2NvZ25pdG8taWRwLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb20vJHtwcm9wcy51c2VyUG9vbElkfS8ud2VsbC1rbm93bi9vcGVuaWQtY29uZmlndXJhdGlvbmAsXG4gICAgICAgICAgfVxuICAgICAgICB9LFxuICAgICAgICBBZ2VudFJ1bnRpbWVBcnRpZmFjdDoge1xuICAgICAgICAgIENvbnRhaW5lckNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICAgIENvbnRhaW5lclVyaTogYCR7cHJvcHMuYmlsbGluZ01jcFJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaX06bGF0ZXN0YFxuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAgTmV0d29ya0NvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBOZXR3b3JrTW9kZTogJ1BVQkxJQydcbiAgICAgICAgfSxcbiAgICAgICAgRW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcbiAgICAgICAgICBBV1NfUkVHSU9OOiB0aGlzLnJlZ2lvbixcbiAgICAgICAgICBERVBMT1lNRU5UX1RJTUVTVEFNUDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICB9LFxuICAgICAgICBQcm90b2NvbENvbmZpZ3VyYXRpb246ICdNQ1AnLFxuICAgICAgICBMaWZlY3ljbGVDb25maWd1cmF0aW9uOiB7fSxcbiAgICAgIH1cbiAgICB9KTtcbiAgICBcbiAgICBjZm5CaWxsaW5nTWNwUnVudGltZS5ub2RlLmFkZERlcGVuZGVuY3koYmlsbGluZ01jcFJ1bnRpbWVSb2xlKTtcblxuICAgIHRoaXMuYmlsbGluZ01jcFJ1bnRpbWVBcm4gPSBjZm5CaWxsaW5nTWNwUnVudGltZS5nZXRBdHQoJ0FnZW50UnVudGltZUFybicpLnRvU3RyaW5nKCk7XG4gICAgLy8gTUNQIFJ1bnRpbWUgZW5kcG9pbnQgZm9ybWF0IGZvciBBZ2VudENvcmUgR2F0ZXdheSB0YXJnZXRzIChmcm9tIEFXUyBkb2N1bWVudGF0aW9uKVxuICAgIC8vIEZvcm1hdDogaHR0cHM6Ly9iZWRyb2NrLWFnZW50Y29yZS57cmVnaW9ufS5hbWF6b25hd3MuY29tL3J1bnRpbWVzL3tFTkNPREVEX0FSTn0vaW52b2NhdGlvbnM/cXVhbGlmaWVyPURFRkFVTFRcbiAgICAvLyBUaGUgQVJOIG11c3QgYmUgVVJMLWVuY29kZWQgKDog4oaSICUzQSwgLyDihpIgJTJGKVxuICAgIC8vIFJlZmVyZW5jZTogaHR0cHM6Ly9kb2NzLmF3cy5hbWF6b24uY29tL2JlZHJvY2stYWdlbnRjb3JlL2xhdGVzdC9kZXZndWlkZS9ydW50aW1lLW1jcC5odG1sXG4gICAgY29uc3QgZW5jb2RlZEJpbGxpbmdBcm4gPSBjZGsuRm4uam9pbignJywgW1xuICAgICAgY2RrLkZuLnNlbGVjdCgwLCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLmJpbGxpbmdNY3BSdW50aW1lQXJuKSksXG4gICAgICAnJTNBJyxcbiAgICAgIGNkay5Gbi5zZWxlY3QoMSwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5iaWxsaW5nTWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDIsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuYmlsbGluZ01jcFJ1bnRpbWVBcm4pKSxcbiAgICAgICclM0EnLFxuICAgICAgY2RrLkZuLnNlbGVjdCgzLCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLmJpbGxpbmdNY3BSdW50aW1lQXJuKSksXG4gICAgICAnJTNBJyxcbiAgICAgIGNkay5Gbi5zZWxlY3QoNCwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5iaWxsaW5nTWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uam9pbignJTJGJywgY2RrLkZuLnNwbGl0KCcvJywgY2RrLkZuLnNlbGVjdCg1LCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLmJpbGxpbmdNY3BSdW50aW1lQXJuKSkpKSxcbiAgICBdKTtcbiAgICB0aGlzLmJpbGxpbmdNY3BSdW50aW1lRW5kcG9pbnQgPSBgaHR0cHM6Ly9iZWRyb2NrLWFnZW50Y29yZS4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tL3J1bnRpbWVzLyR7ZW5jb2RlZEJpbGxpbmdBcm59L2ludm9jYXRpb25zP3F1YWxpZmllcj1ERUZBVUxUYDtcblxuICAgIC8vIFByaWNpbmcgTUNQIFNlcnZlciBSdW50aW1lXG4gICAgY29uc3QgY2ZuUHJpY2luZ01jcFJ1bnRpbWUgPSBuZXcgY2RrLkNmblJlc291cmNlKHRoaXMsICdQcmljaW5nTWNwUnVudGltZScsIHtcbiAgICAgIHR5cGU6ICdBV1M6OkJlZHJvY2tBZ2VudENvcmU6OlJ1bnRpbWUnLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBBZ2VudFJ1bnRpbWVOYW1lOiAnY2xvdWRvcHNfcHJpY2luZ19tY3Bfand0X3YxJyxcbiAgICAgICAgRGVzY3JpcHRpb246ICdBV1MgTGFicyBQcmljaW5nIE1DUCBTZXJ2ZXIgUnVudGltZSB3aXRoIEpXVCBhdXRob3JpemF0aW9uJyxcbiAgICAgICAgUm9sZUFybjogcHJpY2luZ01jcFJ1bnRpbWVSb2xlLnJvbGVBcm4sXG4gICAgICAgIEF1dGhvcml6ZXJDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgQ3VzdG9tSldUQXV0aG9yaXplcjoge1xuICAgICAgICAgICAgQWxsb3dlZENsaWVudHM6IFtwcm9wcy5tMm1DbGllbnRJZF0sXG4gICAgICAgICAgICBEaXNjb3ZlcnlVcmw6IGBodHRwczovL2NvZ25pdG8taWRwLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb20vJHtwcm9wcy51c2VyUG9vbElkfS8ud2VsbC1rbm93bi9vcGVuaWQtY29uZmlndXJhdGlvbmAsXG4gICAgICAgICAgfVxuICAgICAgICB9LFxuICAgICAgICBBZ2VudFJ1bnRpbWVBcnRpZmFjdDoge1xuICAgICAgICAgIENvbnRhaW5lckNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICAgIENvbnRhaW5lclVyaTogYCR7cHJvcHMucHJpY2luZ01jcFJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaX06bGF0ZXN0YFxuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAgTmV0d29ya0NvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBOZXR3b3JrTW9kZTogJ1BVQkxJQydcbiAgICAgICAgfSxcbiAgICAgICAgRW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcbiAgICAgICAgICBBV1NfUkVHSU9OOiB0aGlzLnJlZ2lvbixcbiAgICAgICAgICBERVBMT1lNRU5UX1RJTUVTVEFNUDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICB9LFxuICAgICAgICBQcm90b2NvbENvbmZpZ3VyYXRpb246ICdNQ1AnLFxuICAgICAgICBMaWZlY3ljbGVDb25maWd1cmF0aW9uOiB7fSxcbiAgICAgIH1cbiAgICB9KTtcbiAgICBcbiAgICBjZm5QcmljaW5nTWNwUnVudGltZS5ub2RlLmFkZERlcGVuZGVuY3kocHJpY2luZ01jcFJ1bnRpbWVSb2xlKTtcblxuICAgIHRoaXMucHJpY2luZ01jcFJ1bnRpbWVBcm4gPSBjZm5QcmljaW5nTWNwUnVudGltZS5nZXRBdHQoJ0FnZW50UnVudGltZUFybicpLnRvU3RyaW5nKCk7XG4gICAgLy8gTUNQIFJ1bnRpbWUgZW5kcG9pbnQgZm9ybWF0IGZvciBBZ2VudENvcmUgR2F0ZXdheSB0YXJnZXRzIChmcm9tIEFXUyBkb2N1bWVudGF0aW9uKVxuICAgIC8vIEZvcm1hdDogaHR0cHM6Ly9iZWRyb2NrLWFnZW50Y29yZS57cmVnaW9ufS5hbWF6b25hd3MuY29tL3J1bnRpbWVzL3tFTkNPREVEX0FSTn0vaW52b2NhdGlvbnM/cXVhbGlmaWVyPURFRkFVTFRcbiAgICAvLyBUaGUgQVJOIG11c3QgYmUgVVJMLWVuY29kZWQgKDog4oaSICUzQSwgLyDihpIgJTJGKVxuICAgIC8vIFJlZmVyZW5jZTogaHR0cHM6Ly9kb2NzLmF3cy5hbWF6b24uY29tL2JlZHJvY2stYWdlbnRjb3JlL2xhdGVzdC9kZXZndWlkZS9ydW50aW1lLW1jcC5odG1sXG4gICAgY29uc3QgZW5jb2RlZFByaWNpbmdBcm4gPSBjZGsuRm4uam9pbignJywgW1xuICAgICAgY2RrLkZuLnNlbGVjdCgwLCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLnByaWNpbmdNY3BSdW50aW1lQXJuKSksXG4gICAgICAnJTNBJyxcbiAgICAgIGNkay5Gbi5zZWxlY3QoMSwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5wcmljaW5nTWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDIsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMucHJpY2luZ01jcFJ1bnRpbWVBcm4pKSxcbiAgICAgICclM0EnLFxuICAgICAgY2RrLkZuLnNlbGVjdCgzLCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLnByaWNpbmdNY3BSdW50aW1lQXJuKSksXG4gICAgICAnJTNBJyxcbiAgICAgIGNkay5Gbi5zZWxlY3QoNCwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5wcmljaW5nTWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uam9pbignJTJGJywgY2RrLkZuLnNwbGl0KCcvJywgY2RrLkZuLnNlbGVjdCg1LCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLnByaWNpbmdNY3BSdW50aW1lQXJuKSkpKSxcbiAgICBdKTtcbiAgICB0aGlzLnByaWNpbmdNY3BSdW50aW1lRW5kcG9pbnQgPSBgaHR0cHM6Ly9iZWRyb2NrLWFnZW50Y29yZS4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tL3J1bnRpbWVzLyR7ZW5jb2RlZFByaWNpbmdBcm59L2ludm9jYXRpb25zP3F1YWxpZmllcj1ERUZBVUxUYDtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDbG91ZFdhdGNoIE1DUCBTZXJ2ZXIgUnVudGltZVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIENsb3VkV2F0Y2ggTUNQIFNlcnZlciBSdW50aW1lIFJvbGVcbiAgICBjb25zdCBjbG91ZHdhdGNoTWNwUnVudGltZVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ0Nsb3VkV2F0Y2hNY3BSdW50aW1lUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdiZWRyb2NrLWFnZW50Y29yZS5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgY29tbW9uIHBlcm1pc3Npb25zIHRvIENsb3VkV2F0Y2ggcnVudGltZSByb2xlXG4gICAgZm9yIChjb25zdCBzdG10IG9mIGNvbW1vblJ1bnRpbWVQZXJtaXNzaW9ucykge1xuICAgICAgY2xvdWR3YXRjaE1jcFJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KHN0bXQpO1xuICAgIH1cblxuICAgIC8vIEVDUiBpbWFnZSBwdWxsIGZvciBDbG91ZFdhdGNoIHJlcG9zaXRvcnlcbiAgICBwcm9wcy5jbG91ZHdhdGNoTWNwUmVwb3NpdG9yeS5ncmFudFB1bGwoY2xvdWR3YXRjaE1jcFJ1bnRpbWVSb2xlKTtcblxuICAgIC8vIEdyYW50IENsb3VkV2F0Y2ggYW5kIExvZ3MgcGVybWlzc2lvbnNcbiAgICBjbG91ZHdhdGNoTWNwUnVudGltZVJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnY2xvdWR3YXRjaDoqJyxcbiAgICAgICAgJ2xvZ3M6KicsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICAvLyBDbG91ZFdhdGNoIE1DUCBTZXJ2ZXIgUnVudGltZVxuICAgIGNvbnN0IGNmbkNsb3VkV2F0Y2hNY3BSdW50aW1lID0gbmV3IGNkay5DZm5SZXNvdXJjZSh0aGlzLCAnQ2xvdWRXYXRjaE1jcFJ1bnRpbWUnLCB7XG4gICAgICB0eXBlOiAnQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpSdW50aW1lJyxcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgQWdlbnRSdW50aW1lTmFtZTogJ2Nsb3Vkb3BzX2Nsb3Vkd2F0Y2hfbWNwX2p3dF92MScsXG4gICAgICAgIERlc2NyaXB0aW9uOiAnQVdTIExhYnMgQ2xvdWRXYXRjaCBNQ1AgU2VydmVyIFJ1bnRpbWUgd2l0aCBKV1QgYXV0aG9yaXphdGlvbicsXG4gICAgICAgIFJvbGVBcm46IGNsb3Vkd2F0Y2hNY3BSdW50aW1lUm9sZS5yb2xlQXJuLFxuICAgICAgICBBdXRob3JpemVyQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIEN1c3RvbUpXVEF1dGhvcml6ZXI6IHtcbiAgICAgICAgICAgIEFsbG93ZWRDbGllbnRzOiBbcHJvcHMubTJtQ2xpZW50SWRdLFxuICAgICAgICAgICAgRGlzY292ZXJ5VXJsOiBgaHR0cHM6Ly9jb2duaXRvLWlkcC4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tLyR7cHJvcHMudXNlclBvb2xJZH0vLndlbGwta25vd24vb3BlbmlkLWNvbmZpZ3VyYXRpb25gLFxuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAgQWdlbnRSdW50aW1lQXJ0aWZhY3Q6IHtcbiAgICAgICAgICBDb250YWluZXJDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgICBDb250YWluZXJVcmk6IGAke3Byb3BzLmNsb3Vkd2F0Y2hNY3BSZXBvc2l0b3J5LnJlcG9zaXRvcnlVcml9OmxhdGVzdGBcbiAgICAgICAgICB9XG4gICAgICAgIH0sXG4gICAgICAgIE5ldHdvcmtDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgTmV0d29ya01vZGU6ICdQVUJMSUMnXG4gICAgICAgIH0sXG4gICAgICAgIEVudmlyb25tZW50VmFyaWFibGVzOiB7XG4gICAgICAgICAgQVdTX1JFR0lPTjogdGhpcy5yZWdpb24sXG4gICAgICAgICAgREVQTE9ZTUVOVF9USU1FU1RBTVA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgfSxcbiAgICAgICAgUHJvdG9jb2xDb25maWd1cmF0aW9uOiAnTUNQJyxcbiAgICAgICAgTGlmZWN5Y2xlQ29uZmlndXJhdGlvbjoge30sXG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBjZm5DbG91ZFdhdGNoTWNwUnVudGltZS5ub2RlLmFkZERlcGVuZGVuY3koY2xvdWR3YXRjaE1jcFJ1bnRpbWVSb2xlKTtcblxuICAgIHRoaXMuY2xvdWR3YXRjaE1jcFJ1bnRpbWVBcm4gPSBjZm5DbG91ZFdhdGNoTWNwUnVudGltZS5nZXRBdHQoJ0FnZW50UnVudGltZUFybicpLnRvU3RyaW5nKCk7XG4gICAgLy8gTUNQIFJ1bnRpbWUgZW5kcG9pbnQgZm9ybWF0IGZvciBBZ2VudENvcmUgR2F0ZXdheSB0YXJnZXRzIChmcm9tIEFXUyBkb2N1bWVudGF0aW9uKVxuICAgIC8vIEZvcm1hdDogaHR0cHM6Ly9iZWRyb2NrLWFnZW50Y29yZS57cmVnaW9ufS5hbWF6b25hd3MuY29tL3J1bnRpbWVzL3tFTkNPREVEX0FSTn0vaW52b2NhdGlvbnM/cXVhbGlmaWVyPURFRkFVTFRcbiAgICAvLyBUaGUgQVJOIG11c3QgYmUgVVJMLWVuY29kZWQgKDog4oaSICUzQSwgLyDihpIgJTJGKVxuICAgIGNvbnN0IGVuY29kZWRDbG91ZFdhdGNoQXJuID0gY2RrLkZuLmpvaW4oJycsIFtcbiAgICAgIGNkay5Gbi5zZWxlY3QoMCwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5jbG91ZHdhdGNoTWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDEsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuY2xvdWR3YXRjaE1jcFJ1bnRpbWVBcm4pKSxcbiAgICAgICclM0EnLFxuICAgICAgY2RrLkZuLnNlbGVjdCgyLCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLmNsb3Vkd2F0Y2hNY3BSdW50aW1lQXJuKSksXG4gICAgICAnJTNBJyxcbiAgICAgIGNkay5Gbi5zZWxlY3QoMywgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5jbG91ZHdhdGNoTWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDQsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuY2xvdWR3YXRjaE1jcFJ1bnRpbWVBcm4pKSxcbiAgICAgICclM0EnLFxuICAgICAgY2RrLkZuLmpvaW4oJyUyRicsIGNkay5Gbi5zcGxpdCgnLycsIGNkay5Gbi5zZWxlY3QoNSwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5jbG91ZHdhdGNoTWNwUnVudGltZUFybikpKSksXG4gICAgXSk7XG4gICAgdGhpcy5jbG91ZHdhdGNoTWNwUnVudGltZUVuZHBvaW50ID0gYGh0dHBzOi8vYmVkcm9jay1hZ2VudGNvcmUuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbS9ydW50aW1lcy8ke2VuY29kZWRDbG91ZFdhdGNoQXJufS9pbnZvY2F0aW9ucz9xdWFsaWZpZXI9REVGQVVMVGA7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ2xvdWRUcmFpbCBNQ1AgU2VydmVyIFJ1bnRpbWVcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBDbG91ZFRyYWlsIE1DUCBTZXJ2ZXIgUnVudGltZSBSb2xlXG4gICAgY29uc3QgY2xvdWR0cmFpbE1jcFJ1bnRpbWVSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdDbG91ZFRyYWlsTWNwUnVudGltZVJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnYmVkcm9jay1hZ2VudGNvcmUuYW1hem9uYXdzLmNvbScpLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIGNvbW1vbiBwZXJtaXNzaW9ucyB0byBDbG91ZFRyYWlsIHJ1bnRpbWUgcm9sZVxuICAgIGZvciAoY29uc3Qgc3RtdCBvZiBjb21tb25SdW50aW1lUGVybWlzc2lvbnMpIHtcbiAgICAgIGNsb3VkdHJhaWxNY3BSdW50aW1lUm9sZS5hZGRUb1BvbGljeShzdG10KTtcbiAgICB9XG5cbiAgICAvLyBFQ1IgaW1hZ2UgcHVsbCBmb3IgQ2xvdWRUcmFpbCByZXBvc2l0b3J5XG4gICAgcHJvcHMuY2xvdWR0cmFpbE1jcFJlcG9zaXRvcnkuZ3JhbnRQdWxsKGNsb3VkdHJhaWxNY3BSdW50aW1lUm9sZSk7XG5cbiAgICAvLyBBZGQgQ2xvdWRUcmFpbC1zcGVjaWZpYyBwZXJtaXNzaW9uc1xuICAgIGNsb3VkdHJhaWxNY3BSdW50aW1lUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdjbG91ZHRyYWlsOkxvb2t1cEV2ZW50cycsXG4gICAgICAgICdjbG91ZHRyYWlsOkdldFRyYWlsU3RhdHVzJyxcbiAgICAgICAgJ2Nsb3VkdHJhaWw6RGVzY3JpYmVUcmFpbHMnLFxuICAgICAgICAnY2xvdWR0cmFpbDpHZXRFdmVudFNlbGVjdG9ycycsXG4gICAgICAgICdjbG91ZHRyYWlsOkxpc3RUcmFpbHMnLFxuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuXG4gICAgLy8gQ2xvdWRUcmFpbCBNQ1AgU2VydmVyIFJ1bnRpbWVcbiAgICBjb25zdCBjZm5DbG91ZFRyYWlsTWNwUnVudGltZSA9IG5ldyBjZGsuQ2ZuUmVzb3VyY2UodGhpcywgJ0Nsb3VkVHJhaWxNY3BSdW50aW1lJywge1xuICAgICAgdHlwZTogJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6UnVudGltZScsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEFnZW50UnVudGltZU5hbWU6ICdjbG91ZG9wc19jbG91ZHRyYWlsX21jcF9qd3RfdjEnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ0FXUyBMYWJzIENsb3VkVHJhaWwgTUNQIFNlcnZlciBSdW50aW1lIHdpdGggSldUIGF1dGhvcml6YXRpb24nLFxuICAgICAgICBSb2xlQXJuOiBjbG91ZHRyYWlsTWNwUnVudGltZVJvbGUucm9sZUFybixcbiAgICAgICAgQXV0aG9yaXplckNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICBDdXN0b21KV1RBdXRob3JpemVyOiB7XG4gICAgICAgICAgICBBbGxvd2VkQ2xpZW50czogW3Byb3BzLm0ybUNsaWVudElkXSxcbiAgICAgICAgICAgIERpc2NvdmVyeVVybDogYGh0dHBzOi8vY29nbml0by1pZHAuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbS8ke3Byb3BzLnVzZXJQb29sSWR9Ly53ZWxsLWtub3duL29wZW5pZC1jb25maWd1cmF0aW9uYCxcbiAgICAgICAgICB9XG4gICAgICAgIH0sXG4gICAgICAgIEFnZW50UnVudGltZUFydGlmYWN0OiB7XG4gICAgICAgICAgQ29udGFpbmVyQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgICAgQ29udGFpbmVyVXJpOiBgJHtwcm9wcy5jbG91ZHRyYWlsTWNwUmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpfTpsYXRlc3RgXG4gICAgICAgICAgfVxuICAgICAgICB9LFxuICAgICAgICBOZXR3b3JrQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIE5ldHdvcmtNb2RlOiAnUFVCTElDJ1xuICAgICAgICB9LFxuICAgICAgICBFbnZpcm9ubWVudFZhcmlhYmxlczoge1xuICAgICAgICAgIEFXU19SRUdJT046IHRoaXMucmVnaW9uLFxuICAgICAgICAgIERFUExPWU1FTlRfVElNRVNUQU1QOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgIH0sXG4gICAgICAgIFByb3RvY29sQ29uZmlndXJhdGlvbjogJ01DUCcsXG4gICAgICAgIExpZmVjeWNsZUNvbmZpZ3VyYXRpb246IHt9LFxuICAgICAgfVxuICAgIH0pO1xuXG4gICAgY2ZuQ2xvdWRUcmFpbE1jcFJ1bnRpbWUubm9kZS5hZGREZXBlbmRlbmN5KGNsb3VkdHJhaWxNY3BSdW50aW1lUm9sZSk7XG5cbiAgICB0aGlzLmNsb3VkdHJhaWxNY3BSdW50aW1lQXJuID0gY2ZuQ2xvdWRUcmFpbE1jcFJ1bnRpbWUuZ2V0QXR0KCdBZ2VudFJ1bnRpbWVBcm4nKS50b1N0cmluZygpO1xuICAgIC8vIE1DUCBSdW50aW1lIGVuZHBvaW50IGZvcm1hdCBmb3IgQWdlbnRDb3JlIEdhdGV3YXkgdGFyZ2V0cyAoZnJvbSBBV1MgZG9jdW1lbnRhdGlvbilcbiAgICAvLyBGb3JtYXQ6IGh0dHBzOi8vYmVkcm9jay1hZ2VudGNvcmUue3JlZ2lvbn0uYW1hem9uYXdzLmNvbS9ydW50aW1lcy97RU5DT0RFRF9BUk59L2ludm9jYXRpb25zP3F1YWxpZmllcj1ERUZBVUxUXG4gICAgLy8gVGhlIEFSTiBtdXN0IGJlIFVSTC1lbmNvZGVkICg6IOKGkiAlM0EsIC8g4oaSICUyRilcbiAgICAvLyBSZWZlcmVuY2U6IGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9iZWRyb2NrLWFnZW50Y29yZS9sYXRlc3QvZGV2Z3VpZGUvcnVudGltZS1tY3AuaHRtbFxuICAgIGNvbnN0IGVuY29kZWRDbG91ZFRyYWlsQXJuID0gY2RrLkZuLmpvaW4oJycsIFtcbiAgICAgIGNkay5Gbi5zZWxlY3QoMCwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5jbG91ZHRyYWlsTWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDEsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuY2xvdWR0cmFpbE1jcFJ1bnRpbWVBcm4pKSxcbiAgICAgICclM0EnLFxuICAgICAgY2RrLkZuLnNlbGVjdCgyLCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLmNsb3VkdHJhaWxNY3BSdW50aW1lQXJuKSksXG4gICAgICAnJTNBJyxcbiAgICAgIGNkay5Gbi5zZWxlY3QoMywgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5jbG91ZHRyYWlsTWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDQsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuY2xvdWR0cmFpbE1jcFJ1bnRpbWVBcm4pKSxcbiAgICAgICclM0EnLFxuICAgICAgY2RrLkZuLmpvaW4oJyUyRicsIGNkay5Gbi5zcGxpdCgnLycsIGNkay5Gbi5zZWxlY3QoNSwgY2RrLkZuLnNwbGl0KCc6JywgdGhpcy5jbG91ZHRyYWlsTWNwUnVudGltZUFybikpKSksXG4gICAgXSk7XG4gICAgdGhpcy5jbG91ZHRyYWlsTWNwUnVudGltZUVuZHBvaW50ID0gYGh0dHBzOi8vYmVkcm9jay1hZ2VudGNvcmUuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbS9ydW50aW1lcy8ke2VuY29kZWRDbG91ZFRyYWlsQXJufS9pbnZvY2F0aW9ucz9xdWFsaWZpZXI9REVGQVVMVGA7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRHluYW1vREIgRU9MIFNjaGVkdWxlcyBUYWJsZSAoY29uZGl0aW9uYWwpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGxldCBlb2xUYWJsZU5hbWU6IHN0cmluZztcbiAgICBpZiAocHJvcHMuZW9sVGFibGVOYW1lKSB7XG4gICAgICAvLyBVc2UgZXhpc3RpbmcgdGFibGUgbmFtZVxuICAgICAgZW9sVGFibGVOYW1lID0gcHJvcHMuZW9sVGFibGVOYW1lO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBDcmVhdGUgbmV3IER5bmFtb0RCIHRhYmxlXG4gICAgICBjb25zdCBlb2xUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCAnRW9sU2NoZWR1bGVzVGFibGUnLCB7XG4gICAgICAgIHRhYmxlTmFtZTogJ2F3cy1lb2wtc2NoZWR1bGVzJyxcbiAgICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6ICdzZXJ2aWNlJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgc29ydEtleTogeyBuYW1lOiAndmVyc2lvbicsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7IHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiB0cnVlIH0sXG4gICAgICB9KTtcbiAgICAgIGVvbFRhYmxlTmFtZSA9IGVvbFRhYmxlLnRhYmxlTmFtZTtcbiAgICB9XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gSW52ZW50b3J5IE1DUCBTZXJ2ZXIgUnVudGltZVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIEludmVudG9yeSBNQ1AgU2VydmVyIFJ1bnRpbWUgUm9sZVxuICAgIGNvbnN0IGludmVudG9yeU1jcFJ1bnRpbWVSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdJbnZlbnRvcnlNY3BSdW50aW1lUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdiZWRyb2NrLWFnZW50Y29yZS5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgY29tbW9uIHBlcm1pc3Npb25zIHRvIEludmVudG9yeSBydW50aW1lIHJvbGVcbiAgICBmb3IgKGNvbnN0IHN0bXQgb2YgY29tbW9uUnVudGltZVBlcm1pc3Npb25zKSB7XG4gICAgICBpbnZlbnRvcnlNY3BSdW50aW1lUm9sZS5hZGRUb1BvbGljeShzdG10KTtcbiAgICB9XG5cbiAgICAvLyBFQ1IgaW1hZ2UgcHVsbCBmb3IgSW52ZW50b3J5IHJlcG9zaXRvcnlcbiAgICBwcm9wcy5pbnZlbnRvcnlNY3BSZXBvc2l0b3J5LmdyYW50UHVsbChpbnZlbnRvcnlNY3BSdW50aW1lUm9sZSk7XG5cbiAgICAvLyBHcmFudCByZWFkLW9ubHkgYWNjZXNzIHRvIEVLUywgUkRTLCBPcGVuU2VhcmNoLCBFbGFzdGlDYWNoZSwgTVNLLCBhbmQgRUMyIERlc2NyaWJlUmVnaW9uc1xuICAgIGludmVudG9yeU1jcFJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2VrczpMaXN0Q2x1c3RlcnMnLFxuICAgICAgICAnZWtzOkRlc2NyaWJlQ2x1c3RlcicsXG4gICAgICAgICdla3M6TGlzdE5vZGVncm91cHMnLFxuICAgICAgICAnZWtzOkRlc2NyaWJlTm9kZWdyb3VwJyxcbiAgICAgICAgJ3JkczpEZXNjcmliZURCSW5zdGFuY2VzJyxcbiAgICAgICAgJ3JkczpEZXNjcmliZURCQ2x1c3RlcnMnLFxuICAgICAgICAncmRzOkRlc2NyaWJlREJFbmdpbmVWZXJzaW9ucycsXG4gICAgICAgICdlczpMaXN0RG9tYWluTmFtZXMnLFxuICAgICAgICAnZXM6RGVzY3JpYmVEb21haW4nLFxuICAgICAgICAnZXM6RGVzY3JpYmVEb21haW5zJyxcbiAgICAgICAgJ2VsYXN0aWNhY2hlOkRlc2NyaWJlQ2FjaGVDbHVzdGVycycsXG4gICAgICAgICdlbGFzdGljYWNoZTpEZXNjcmliZVJlcGxpY2F0aW9uR3JvdXBzJyxcbiAgICAgICAgJ2thZmthOkxpc3RDbHVzdGVycycsXG4gICAgICAgICdrYWZrYTpMaXN0Q2x1c3RlcnNWMicsXG4gICAgICAgICdrYWZrYTpEZXNjcmliZUNsdXN0ZXInLFxuICAgICAgICAna2Fma2E6RGVzY3JpYmVDbHVzdGVyVjInLFxuICAgICAgICAnZWMyOkRlc2NyaWJlUmVnaW9ucycsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICAvLyBHcmFudCBEeW5hbW9EQiByZWFkIGFjY2VzcyBvbiBFT0wgdGFibGVcbiAgICBjb25zdCBlb2xUYWJsZUFybiA9IGBhcm46YXdzOmR5bmFtb2RiOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTp0YWJsZS8ke2VvbFRhYmxlTmFtZX1gO1xuICAgIGludmVudG9yeU1jcFJ1bnRpbWVSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2R5bmFtb2RiOkdldEl0ZW0nLFxuICAgICAgICAnZHluYW1vZGI6UXVlcnknLFxuICAgICAgICAnZHluYW1vZGI6U2NhbicsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbZW9sVGFibGVBcm5dLFxuICAgIH0pKTtcblxuICAgIC8vIEludmVudG9yeSBNQ1AgU2VydmVyIFJ1bnRpbWVcbiAgICBjb25zdCBjZm5JbnZlbnRvcnlNY3BSdW50aW1lID0gbmV3IGNkay5DZm5SZXNvdXJjZSh0aGlzLCAnSW52ZW50b3J5TWNwUnVudGltZScsIHtcbiAgICAgIHR5cGU6ICdBV1M6OkJlZHJvY2tBZ2VudENvcmU6OlJ1bnRpbWUnLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBBZ2VudFJ1bnRpbWVOYW1lOiAnY2xvdWRvcHNfaW52ZW50b3J5X21jcF9qd3RfdjEnLFxuICAgICAgICBEZXNjcmlwdGlvbjogJ0ludmVudG9yeSBNQ1AgU2VydmVyIFJ1bnRpbWUgd2l0aCBKV1QgYXV0aG9yaXphdGlvbicsXG4gICAgICAgIFJvbGVBcm46IGludmVudG9yeU1jcFJ1bnRpbWVSb2xlLnJvbGVBcm4sXG4gICAgICAgIEF1dGhvcml6ZXJDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgQ3VzdG9tSldUQXV0aG9yaXplcjoge1xuICAgICAgICAgICAgQWxsb3dlZENsaWVudHM6IFtwcm9wcy5tMm1DbGllbnRJZF0sXG4gICAgICAgICAgICBEaXNjb3ZlcnlVcmw6IGBodHRwczovL2NvZ25pdG8taWRwLiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb20vJHtwcm9wcy51c2VyUG9vbElkfS8ud2VsbC1rbm93bi9vcGVuaWQtY29uZmlndXJhdGlvbmAsXG4gICAgICAgICAgfVxuICAgICAgICB9LFxuICAgICAgICBBZ2VudFJ1bnRpbWVBcnRpZmFjdDoge1xuICAgICAgICAgIENvbnRhaW5lckNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICAgIENvbnRhaW5lclVyaTogYCR7cHJvcHMuaW52ZW50b3J5TWNwUmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpfTpsYXRlc3RgXG4gICAgICAgICAgfVxuICAgICAgICB9LFxuICAgICAgICBOZXR3b3JrQ29uZmlndXJhdGlvbjoge1xuICAgICAgICAgIE5ldHdvcmtNb2RlOiAnUFVCTElDJ1xuICAgICAgICB9LFxuICAgICAgICBFbnZpcm9ubWVudFZhcmlhYmxlczoge1xuICAgICAgICAgIEFXU19SRUdJT046IHRoaXMucmVnaW9uLFxuICAgICAgICAgIEVPTF9UQUJMRV9OQU1FOiBlb2xUYWJsZU5hbWUsXG4gICAgICAgICAgTUNQX1RSQU5TUE9SVDogJ3N0cmVhbWFibGUtaHR0cCcsXG4gICAgICAgICAgREVQTE9ZTUVOVF9USU1FU1RBTVA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgfSxcbiAgICAgICAgUHJvdG9jb2xDb25maWd1cmF0aW9uOiAnTUNQJyxcbiAgICAgICAgTGlmZWN5Y2xlQ29uZmlndXJhdGlvbjoge30sXG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBjZm5JbnZlbnRvcnlNY3BSdW50aW1lLm5vZGUuYWRkRGVwZW5kZW5jeShpbnZlbnRvcnlNY3BSdW50aW1lUm9sZSk7XG5cbiAgICB0aGlzLmludmVudG9yeU1jcFJ1bnRpbWVBcm4gPSBjZm5JbnZlbnRvcnlNY3BSdW50aW1lLmdldEF0dCgnQWdlbnRSdW50aW1lQXJuJykudG9TdHJpbmcoKTtcbiAgICAvLyBNQ1AgUnVudGltZSBlbmRwb2ludCBmb3JtYXQgZm9yIEFnZW50Q29yZSBHYXRld2F5IHRhcmdldHMgKGZyb20gQVdTIGRvY3VtZW50YXRpb24pXG4gICAgLy8gRm9ybWF0OiBodHRwczovL2JlZHJvY2stYWdlbnRjb3JlLntyZWdpb259LmFtYXpvbmF3cy5jb20vcnVudGltZXMve0VOQ09ERURfQVJOfS9pbnZvY2F0aW9ucz9xdWFsaWZpZXI9REVGQVVMVFxuICAgIC8vIFRoZSBBUk4gbXVzdCBiZSBVUkwtZW5jb2RlZCAoOiDihpIgJTNBLCAvIOKGkiAlMkYpXG4gICAgY29uc3QgZW5jb2RlZEludmVudG9yeUFybiA9IGNkay5Gbi5qb2luKCcnLCBbXG4gICAgICBjZGsuRm4uc2VsZWN0KDAsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuaW52ZW50b3J5TWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDEsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuaW52ZW50b3J5TWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDIsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuaW52ZW50b3J5TWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDMsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuaW52ZW50b3J5TWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uc2VsZWN0KDQsIGNkay5Gbi5zcGxpdCgnOicsIHRoaXMuaW52ZW50b3J5TWNwUnVudGltZUFybikpLFxuICAgICAgJyUzQScsXG4gICAgICBjZGsuRm4uam9pbignJTJGJywgY2RrLkZuLnNwbGl0KCcvJywgY2RrLkZuLnNlbGVjdCg1LCBjZGsuRm4uc3BsaXQoJzonLCB0aGlzLmludmVudG9yeU1jcFJ1bnRpbWVBcm4pKSkpLFxuICAgIF0pO1xuICAgIHRoaXMuaW52ZW50b3J5TWNwUnVudGltZUVuZHBvaW50ID0gYGh0dHBzOi8vYmVkcm9jay1hZ2VudGNvcmUuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbS9ydW50aW1lcy8ke2VuY29kZWRJbnZlbnRvcnlBcm59L2ludm9jYXRpb25zP3F1YWxpZmllcj1ERUZBVUxUYDtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBFT0wgU2NyYXBlciBMYW1iZGEgRnVuY3Rpb25cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICBjb25zdCBlb2xTY3JhcGVyUGF0aCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi8uLi9tY3Atc2VydmVycy9pbnZlbnRvcnkvZW9sLXNjcmFwZXInKTtcbiAgICBjb25zdCBlb2xTY3JhcGVyRnVuY3Rpb24gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdFb2xTY3JhcGVyRnVuY3Rpb24nLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1Fb2xTY3JhcGVyYCxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEyLFxuICAgICAgaGFuZGxlcjogJ2VvbF9zY3JhcGVyLm1haW4uaGFuZGxlcicsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoZW9sU2NyYXBlclBhdGgsIHtcbiAgICAgICAgYnVuZGxpbmc6IHtcbiAgICAgICAgICBpbWFnZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTIuYnVuZGxpbmdJbWFnZSxcbiAgICAgICAgICBjb21tYW5kOiBbXG4gICAgICAgICAgICAnYmFzaCcsICctYycsXG4gICAgICAgICAgICAvLyAtLW5vLXdhcm4tY29uZmxpY3RzOiB0aGUgc2NyYXBlcidzIGRlcHMgKGJvdG8zL3JlcXVlc3RzL2JzNCkgYXJlXG4gICAgICAgICAgICAvLyBwdXJlLVB5dGhvbiBhbmQgaW5zdGFsbCBjbGVhbmx5IGludG8gdGhlIGFzc2V0IGRpcjsgdGhlIGZsYWcganVzdFxuICAgICAgICAgICAgLy8gc3VwcHJlc3NlcyBwaXAncyBub2lzeSBub3RpY2UgYWJvdXQgVU5SRUxBVEVEIHBhY2thZ2VzIHRoYXQgaGFwcGVuXG4gICAgICAgICAgICAvLyB0byBiZSBwcmVzZW50IGluIHRoZSBzdXJyb3VuZGluZyBlbnZpcm9ubWVudC5cbiAgICAgICAgICAgICdwaXAgaW5zdGFsbCAtciByZXF1aXJlbWVudHMudHh0IC10IC9hc3NldC1vdXRwdXQgLS1uby13YXJuLWNvbmZsaWN0cyAmJiBjcCAtYXUgLiAvYXNzZXQtb3V0cHV0JyxcbiAgICAgICAgICBdLFxuICAgICAgICAgIGxvY2FsOiB7XG4gICAgICAgICAgICB0cnlCdW5kbGUob3V0cHV0RGlyOiBzdHJpbmcpIHtcbiAgICAgICAgICAgICAgLy8gVXNlIGV4ZWNGaWxlU3luYyB3aXRoIGFuIGV4cGxpY2l0IGFyZ3VtZW50IHZlY3RvciAoTk9UIGEgc2hlbGxcbiAgICAgICAgICAgICAgLy8gc3RyaW5nKSBzbyBubyBzaGVsbCBpcyBzcGF3bmVkIGFuZCB0aGVyZSBpcyBubyBjb21tYW5kLWluamVjdGlvblxuICAgICAgICAgICAgICAvLyBzdXJmYWNlIOKAlCBpbnB1dHMgYXJlIENESy1jb250cm9sbGVkIGJ1aWxkIHBhdGhzIHJlZ2FyZGxlc3MuXG4gICAgICAgICAgICAgIC8vIC0tbm8td2Fybi1jb25mbGljdHMgc2lsZW5jZXMgcGlwJ3MgXCJkZXBlbmRlbmN5IHJlc29sdmVyIGRvZXMgbm90XG4gICAgICAgICAgICAgIC8vIGN1cnJlbnRseSB0YWtlIGludG8gYWNjb3VudC4uLlwiIG5vdGljZSAodHJpZ2dlcmVkIGJ5IHVucmVsYXRlZFxuICAgICAgICAgICAgICAvLyBwYWNrYWdlcyBpbiB0aGUgaG9zdCBQeXRob24gZW52LCBub3QgdGhlIHNjcmFwZXIncyBkZXBzKS5cbiAgICAgICAgICAgICAgY29uc3QgeyBleGVjRmlsZVN5bmMgfSA9IHJlcXVpcmUoJ2NoaWxkX3Byb2Nlc3MnKTtcbiAgICAgICAgICAgICAgY29uc3QgZnMgPSByZXF1aXJlKCdmcycpO1xuICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGV4ZWNGaWxlU3luYyhcbiAgICAgICAgICAgICAgICAgICdweXRob24zJyxcbiAgICAgICAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgICAgICAgJy1tJywgJ3BpcCcsICdpbnN0YWxsJyxcbiAgICAgICAgICAgICAgICAgICAgJy1yJywgYCR7ZW9sU2NyYXBlclBhdGh9L3JlcXVpcmVtZW50cy50eHRgLFxuICAgICAgICAgICAgICAgICAgICAnLXQnLCBvdXRwdXREaXIsXG4gICAgICAgICAgICAgICAgICAgICctLXF1aWV0JywgJy0tbm8td2Fybi1jb25mbGljdHMnLFxuICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgIHsgc3RkaW86ICdpZ25vcmUnIH0sXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAvLyBDb3B5IHRoZSBwYWNrYWdlIHNvdXJjZSB3aXRoIHRoZSBOb2RlIGZzIEFQSSDigJQgbm8gc3VicHJvY2Vzcy5cbiAgICAgICAgICAgICAgICBmcy5jcFN5bmMoYCR7ZW9sU2NyYXBlclBhdGh9L2VvbF9zY3JhcGVyYCwgYCR7b3V0cHV0RGlyfS9lb2xfc2NyYXBlcmAsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgbWVtb3J5U2l6ZTogNTEyLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBFT0xfVEFCTEVfTkFNRTogZW9sVGFibGVOYW1lLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEdyYW50IER5bmFtb0RCIHdyaXRlIHBlcm1pc3Npb25zIHRvIExhbWJkYVxuICAgIGVvbFNjcmFwZXJGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnZHluYW1vZGI6UHV0SXRlbScsXG4gICAgICAgICdkeW5hbW9kYjpCYXRjaFdyaXRlSXRlbScsXG4gICAgICAgICdkeW5hbW9kYjpDcmVhdGVUYWJsZScsXG4gICAgICAgICdkeW5hbW9kYjpEZXNjcmliZVRhYmxlJyxcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtlb2xUYWJsZUFybl0sXG4gICAgfSkpO1xuXG4gICAgLy8gR3JhbnQgRUtTIERlc2NyaWJlQ2x1c3RlclZlcnNpb25zIHBlcm1pc3Npb25cbiAgICBlb2xTY3JhcGVyRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2VrczpEZXNjcmliZUNsdXN0ZXJWZXJzaW9ucycsXG4gICAgICAgICdlczpMaXN0VmVyc2lvbnMnLFxuICAgICAgICAnZXM6TGlzdEVsYXN0aWNzZWFyY2hWZXJzaW9ucycsXG4gICAgICAgICdlbGFzdGljYWNoZTpEZXNjcmliZUNhY2hlRW5naW5lVmVyc2lvbnMnLFxuICAgICAgICAna2Fma2E6R2V0Q29tcGF0aWJsZUthZmthVmVyc2lvbnMnLFxuICAgICAgICAncmRzOkRlc2NyaWJlREJFbmdpbmVWZXJzaW9ucycsXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICAvLyBFdmVudEJyaWRnZSBydWxlIHRvIHRyaWdnZXIgTGFtYmRhIGRhaWx5XG4gICAgY29uc3QgZW9sU2NyYXBlclNjaGVkdWxlID0gbmV3IGV2ZW50cy5SdWxlKHRoaXMsICdFb2xTY3JhcGVyU2NoZWR1bGUnLCB7XG4gICAgICBydWxlTmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUVvbFNjcmFwZXJEYWlseVNjaGVkdWxlYCxcbiAgICAgIHNjaGVkdWxlOiBldmVudHMuU2NoZWR1bGUucmF0ZShjZGsuRHVyYXRpb24uZGF5cygxKSksXG4gICAgfSk7XG4gICAgZW9sU2NyYXBlclNjaGVkdWxlLmFkZFRhcmdldChuZXcgZXZlbnRzX3RhcmdldHMuTGFtYmRhRnVuY3Rpb24oZW9sU2NyYXBlckZ1bmN0aW9uKSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIFRoZSBFT0wgc2NyYXBlciBydW5zIG9uIGEgREFJTFkgc2NoZWR1bGUsIHNvIHRoZSBFT0wgdGFibGUgaXMgRU1QVFkgdW50aWxcbiAgICAvLyB0aGUgZmlyc3Qgc2NoZWR1bGVkIHJ1bi4gQWZ0ZXIgZGVwbG95bWVudCwgaW52b2tlIGl0IG9uY2UgbWFudWFsbHkgdG9cbiAgICAvLyBwb3B1bGF0ZSB0aGUgdGFibGUgaW1tZWRpYXRlbHkgKHNlZSBSRUFETUUgXCJQb3B1bGF0ZSB0aGUgRU9MIGRhdGFcIikuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0VvbFNjcmFwZXJGdW5jdGlvbk5hbWUnLCB7XG4gICAgICB2YWx1ZTogZW9sU2NyYXBlckZ1bmN0aW9uLmZ1bmN0aW9uTmFtZSxcbiAgICAgIC8vIE5PVEU6IGFuIE91dHB1dCBEZXNjcmlwdGlvbiBtdXN0IGJlIGEgbGl0ZXJhbCBzdHJpbmcg4oCUIGRvIE5PVCBpbnRlcnBvbGF0ZVxuICAgICAgLy8gQ0RLIHRva2VucyAoZS5nLiBmdW5jdGlvbk5hbWUvcmVnaW9uKSBoZXJlLCBvciBDbG91ZEZvcm1hdGlvbiByZW5kZXJzIGl0XG4gICAgICAvLyBhcyBhbiBGbjo6Sm9pbiBhbmQgcmVqZWN0cyB0aGUgdGVtcGxhdGUgKFwiRXZlcnkgRGVzY3JpcHRpb24gbWVtYmVyIG11c3RcbiAgICAgIC8vIGJlIGEgc3RyaW5nXCIpLiBUaGUgZnVuY3Rpb24gbmFtZSBpcyBjYXJyaWVkIGluIGB2YWx1ZWA7IGludm9rZSB3aXRoOlxuICAgICAgLy8gICBhd3MgbGFtYmRhIGludm9rZSAtLWZ1bmN0aW9uLW5hbWUgPHZhbHVlPiAtLXJlZ2lvbiA8cmVnaW9uPiAvZGV2L3N0ZG91dFxuICAgICAgZGVzY3JpcHRpb246ICdFT0wgc2NyYXBlciBMYW1iZGEgbmFtZSDigJQgaW52b2tlIG9uY2UgYWZ0ZXIgZGVwbG95IHRvIHBvcHVsYXRlIHRoZSBFT0wgdGFibGUgKHNlZSBSRUFETUUpLicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tRW9sU2NyYXBlckZ1bmN0aW9uTmFtZWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQmlsbGluZ01jcFJ1bnRpbWVBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5iaWxsaW5nTWNwUnVudGltZUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQmlsbGluZyBNQ1AgU2VydmVyIFJ1bnRpbWUgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1CaWxsaW5nTWNwUnVudGltZUFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQmlsbGluZ01jcFJ1bnRpbWVFbmRwb2ludCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmJpbGxpbmdNY3BSdW50aW1lRW5kcG9pbnQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0JpbGxpbmcgTUNQIFNlcnZlciBSdW50aW1lIEVuZHBvaW50JyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1CaWxsaW5nTWNwUnVudGltZUVuZHBvaW50YCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdQcmljaW5nTWNwUnVudGltZUFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnByaWNpbmdNY3BSdW50aW1lQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdQcmljaW5nIE1DUCBTZXJ2ZXIgUnVudGltZSBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVByaWNpbmdNY3BSdW50aW1lQXJuYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdQcmljaW5nTWNwUnVudGltZUVuZHBvaW50Jywge1xuICAgICAgdmFsdWU6IHRoaXMucHJpY2luZ01jcFJ1bnRpbWVFbmRwb2ludCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUHJpY2luZyBNQ1AgU2VydmVyIFJ1bnRpbWUgRW5kcG9pbnQnLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVByaWNpbmdNY3BSdW50aW1lRW5kcG9pbnRgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Nsb3VkV2F0Y2hNY3BSdW50aW1lQXJuT3V0cHV0Jywge1xuICAgICAgdmFsdWU6IHRoaXMuY2xvdWR3YXRjaE1jcFJ1bnRpbWVBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0Nsb3VkV2F0Y2ggTUNQIFNlcnZlciBSdW50aW1lIEFSTicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQ2xvdWRXYXRjaE1jcFJ1bnRpbWVBcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Nsb3VkV2F0Y2hNY3BSdW50aW1lRW5kcG9pbnRPdXRwdXQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5jbG91ZHdhdGNoTWNwUnVudGltZUVuZHBvaW50LFxuICAgICAgZGVzY3JpcHRpb246ICdDbG91ZFdhdGNoIE1DUCBTZXJ2ZXIgUnVudGltZSBFbmRwb2ludCcsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQ2xvdWRXYXRjaE1jcFJ1bnRpbWVFbmRwb2ludGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2xvdWRUcmFpbE1jcFJ1bnRpbWVBcm5PdXRwdXQnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5jbG91ZHRyYWlsTWNwUnVudGltZUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ2xvdWRUcmFpbCBNQ1AgU2VydmVyIFJ1bnRpbWUgQVJOJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1DbG91ZFRyYWlsTWNwUnVudGltZUFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2xvdWRUcmFpbE1jcFJ1bnRpbWVFbmRwb2ludE91dHB1dCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmNsb3VkdHJhaWxNY3BSdW50aW1lRW5kcG9pbnQsXG4gICAgICBkZXNjcmlwdGlvbjogJ0Nsb3VkVHJhaWwgTUNQIFNlcnZlciBSdW50aW1lIEVuZHBvaW50JyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1DbG91ZFRyYWlsTWNwUnVudGltZUVuZHBvaW50YCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdJbnZlbnRvcnlNY3BSdW50aW1lQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMuaW52ZW50b3J5TWNwUnVudGltZUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnSW52ZW50b3J5IE1DUCBTZXJ2ZXIgUnVudGltZSBBUk4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUludmVudG9yeU1jcFJ1bnRpbWVBcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0ludmVudG9yeU1jcFJ1bnRpbWVFbmRwb2ludCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmludmVudG9yeU1jcFJ1bnRpbWVFbmRwb2ludCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnSW52ZW50b3J5IE1DUCBTZXJ2ZXIgUnVudGltZSBFbmRwb2ludCcsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tSW52ZW50b3J5TWNwUnVudGltZUVuZHBvaW50YCxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDREstTmFnIFN1cHByZXNzaW9uc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhiaWxsaW5nTWNwUnVudGltZVJvbGUsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBDb3N0IEV4cGxvcmVyIEFQSXMgKGFjY291bnQtbGV2ZWwgc2VydmljZXMpLCBFQ1IgYXV0aCB0b2tlbiwgQ2xvdWRXYXRjaCwgWC1SYXknLFxuICAgICAgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhwcmljaW5nTWNwUnVudGltZVJvbGUsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBBV1MgUHJpY2luZyBBUEkgKGdsb2JhbCBzZXJ2aWNlKSwgRUNSIGF1dGggdG9rZW4sIENsb3VkV2F0Y2gsIFgtUmF5JyxcbiAgICAgIH0sXG4gICAgXSwgdHJ1ZSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMoY2xvdWR3YXRjaE1jcFJ1bnRpbWVSb2xlLCBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxuICAgICAgICByZWFzb246ICdXaWxkY2FyZCBwZXJtaXNzaW9ucyByZXF1aXJlZCBmb3IgQ2xvdWRXYXRjaCBhbmQgTG9ncyBBUElzIChhY2NvdW50LWxldmVsIHNlcnZpY2VzKSwgRUNSIGF1dGggdG9rZW4nLFxuICAgICAgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhjbG91ZHRyYWlsTWNwUnVudGltZVJvbGUsIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgICAgIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBDbG91ZFRyYWlsIEFQSXMgKGFjY291bnQtbGV2ZWwgc2VydmljZXMpLCBFQ1IgYXV0aCB0b2tlbicsXG4gICAgICB9LFxuICAgIF0sIHRydWUpO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKGludmVudG9yeU1jcFJ1bnRpbWVSb2xlLCBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxuICAgICAgICByZWFzb246ICdXaWxkY2FyZCBwZXJtaXNzaW9ucyByZXF1aXJlZCBmb3IgRUtTLCBSRFMsIE9wZW5TZWFyY2gsIEVsYXN0aUNhY2hlLCBNU0sgcmVhZC1vbmx5IEFQSXMgKGFjY291bnQtbGV2ZWwgc2VydmljZXMpLCBFQ1IgYXV0aCB0b2tlbicsXG4gICAgICB9LFxuICAgIF0sIHRydWUpO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKGVvbFNjcmFwZXJGdW5jdGlvbiwgW1xuICAgICAge1xuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JyxcbiAgICAgICAgcmVhc29uOiAnV2lsZGNhcmQgcGVybWlzc2lvbnMgcmVxdWlyZWQgZm9yIEVLUyBEZXNjcmliZUNsdXN0ZXJWZXJzaW9ucyAoYWNjb3VudC1sZXZlbCBBUEkpJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTQnLFxuICAgICAgICByZWFzb246ICdBV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUgbWFuYWdlZCBwb2xpY3kgaXMgQVdTIGJlc3QgcHJhY3RpY2UgZm9yIExhbWJkYSBmdW5jdGlvbnMnLFxuICAgICAgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRTdGFja1N1cHByZXNzaW9ucyh0aGlzLCBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUwxJyxcbiAgICAgICAgcmVhc29uOiAnUHl0aG9uIDMuMTQgaXMgdGhlIGxhdGVzdCBMYW1iZGEgcnVudGltZSB2ZXJzaW9uIGF2YWlsYWJsZScsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU00JyxcbiAgICAgICAgcmVhc29uOiAnQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlIG1hbmFnZWQgcG9saWN5IGlzIEFXUyBiZXN0IHByYWN0aWNlIGZvciBMYW1iZGEgZnVuY3Rpb25zJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxuICAgICAgICByZWFzb246ICdXaWxkY2FyZCBwZXJtaXNzaW9ucyByZXF1aXJlZCBmb3IgY3VzdG9tIHJlc291cmNlIExhbWJkYSBmdW5jdGlvbnMnLFxuICAgICAgfSxcbiAgICBdKTtcbiAgfVxufVxuIl19