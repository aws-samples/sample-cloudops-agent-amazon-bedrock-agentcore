import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as path from 'path';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

export interface MCPRuntimeStackProps extends cdk.StackProps {
  billingMcpRepository: ecr.IRepository;
  pricingMcpRepository: ecr.IRepository;
  cloudwatchMcpRepository: ecr.IRepository;
  cloudtrailMcpRepository: ecr.IRepository;
  inventoryMcpRepository: ecr.IRepository;
  // From AuthStack - for JWT authorization on runtimes
  userPoolId: string;
  m2mClientId: string;
  eolTableName?: string;
}

export class MCPRuntimeStack extends cdk.Stack {
  public readonly billingMcpRuntimeArn: string;
  public readonly pricingMcpRuntimeArn: string;
  public readonly cloudwatchMcpRuntimeArn: string;
  public readonly cloudtrailMcpRuntimeArn: string;
  public readonly inventoryMcpRuntimeArn: string;
  public readonly billingMcpRuntimeEndpoint: string;
  public readonly pricingMcpRuntimeEndpoint: string;
  public readonly cloudwatchMcpRuntimeEndpoint: string;
  public readonly cloudtrailMcpRuntimeEndpoint: string;
  public readonly inventoryMcpRuntimeEndpoint: string;

  constructor(scope: Construct, id: string, props: MCPRuntimeStackProps) {
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
    const commonRuntimePermissions: iam.PolicyStatement[] = [
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
    let eolTableName: string;
    if (props.eolTableName) {
      // Use existing table name
      eolTableName = props.eolTableName;
    } else {
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
            tryBundle(outputDir: string) {
              // Use execFileSync with an explicit argument vector (NOT a shell
              // string) so no shell is spawned and there is no command-injection
              // surface — inputs are CDK-controlled build paths regardless.
              // --no-warn-conflicts silences pip's "dependency resolver does not
              // currently take into account..." notice (triggered by unrelated
              // packages in the host Python env, not the scraper's deps).
              const { execFileSync } = require('child_process');
              const fs = require('fs');
              try {
                execFileSync(
                  'python3',
                  [
                    '-m', 'pip', 'install',
                    '-r', `${eolScraperPath}/requirements.txt`,
                    '-t', outputDir,
                    '--quiet', '--no-warn-conflicts',
                  ],
                  { stdio: 'ignore' },
                );
                // Copy the package source with the Node fs API — no subprocess.
                fs.cpSync(`${eolScraperPath}/eol_scraper`, `${outputDir}/eol_scraper`, { recursive: true });
                return true;
              } catch {
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

    NagSuppressions.addResourceSuppressions(billingMcpRuntimeRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard permissions required for Cost Explorer APIs (account-level services), ECR auth token, CloudWatch, X-Ray',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(pricingMcpRuntimeRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard permissions required for AWS Pricing API (global service), ECR auth token, CloudWatch, X-Ray',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(cloudwatchMcpRuntimeRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard permissions required for CloudWatch and Logs APIs (account-level services), ECR auth token',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(cloudtrailMcpRuntimeRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard permissions required for CloudTrail APIs (account-level services), ECR auth token',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(inventoryMcpRuntimeRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard permissions required for EKS, RDS, OpenSearch, ElastiCache, MSK read-only APIs (account-level services), ECR auth token',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(eolScraperFunction, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard permissions required for EKS DescribeClusterVersions (account-level API)',
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole managed policy is AWS best practice for Lambda functions',
      },
    ], true);

    NagSuppressions.addStackSuppressions(this, [
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
