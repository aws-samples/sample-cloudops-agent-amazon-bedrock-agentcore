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
exports.ImageStack = exports.LOCAL_ARTIFACTS = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const ecr = __importStar(require("aws-cdk-lib/aws-ecr"));
const codebuild = __importStar(require("aws-cdk-lib/aws-codebuild"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const s3deploy = __importStar(require("aws-cdk-lib/aws-s3-deployment"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const crypto = __importStar(require("crypto"));
const path = __importStar(require("path"));
const cdk_nag_1 = require("cdk-nag");
// Local-only build artifacts that must never enter a CodeBuild source asset.
// A developer `uv sync` leaves a ~60 MB / 3.7k-file .venv in the source tree;
// BucketDeployment then uploads it object-by-object and times out. Same list
// as scripts/make/plan-hash.sh. Bare names match at any depth and prune the
// whole directory; `dir/**` would not, because `**` skips dotfiles such as
// .venv/.gitignore.
exports.LOCAL_ARTIFACTS = [
    'node_modules',
    '.venv',
    '__pycache__',
    '.pytest_cache',
    '.hypothesis',
    '*.pyc',
];
/**
 * ImageStack: Builds Docker images for MCP server runtimes using the
 * stdio-to-HTTP patching pattern.
 *
 * For each MCP server (billing, pricing):
 *   1. CodeBuild clones the upstream AWS Labs MCP repo
 *   2. patch-{server}.sh patches server.py for streamable-http transport
 *   3. Adds uvicorn + starlette dependencies
 *   4. Patches Dockerfile (EXPOSE 8000, entrypoint, healthcheck)
 *   5. Builds ARM64 Docker image and pushes to ECR
 *
 * Based on: https://github.com/aws-samples/sample-aws-stdio-http-proxy-mcp
 */
class ImageStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // ECR Repository for Main Agent Runtime image
        this.repository = new ecr.Repository(this, 'RuntimeRepository', {
            repositoryName: 'cloudops-agent-runtime',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
            imageScanOnPush: true,
            lifecycleRules: [{ description: 'Keep last 10 images', maxImageCount: 10 }],
        });
        // ECR Repository for Billing MCP Server Runtime
        this.billingMcpRepository = new ecr.Repository(this, 'BillingMcpRepository', {
            repositoryName: 'cloudops-billing-mcp-runtime',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
            imageScanOnPush: true,
            lifecycleRules: [{ description: 'Keep last 10 images', maxImageCount: 10 }],
        });
        // ECR Repository for Pricing MCP Server Runtime
        this.pricingMcpRepository = new ecr.Repository(this, 'PricingMcpRepository', {
            repositoryName: 'cloudops-pricing-mcp-runtime',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
            imageScanOnPush: true,
            lifecycleRules: [{ description: 'Keep last 10 images', maxImageCount: 10 }],
        });
        // ECR Repository for CloudWatch MCP Server Runtime
        this.cloudwatchMcpRepository = new ecr.Repository(this, 'CloudWatchMcpRepository', {
            repositoryName: 'cloudops-cloudwatch-mcp-runtime',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
            imageScanOnPush: true,
            lifecycleRules: [{ description: 'Keep last 10 images', maxImageCount: 10 }],
        });
        // ECR Repository for CloudTrail MCP Server Runtime
        this.cloudtrailMcpRepository = new ecr.Repository(this, 'CloudTrailMcpRepository', {
            repositoryName: 'cloudops-cloudtrail-mcp-runtime',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
            imageScanOnPush: true,
            lifecycleRules: [{ description: 'Keep last 10 images', maxImageCount: 10 }],
        });
        // ECR Repository for Inventory MCP Server Runtime
        this.inventoryMcpRepository = new ecr.Repository(this, 'InventoryMcpRepository', {
            repositoryName: 'cloudops-inventory-mcp-runtime',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
            imageScanOnPush: true,
            lifecycleRules: [{ description: 'Keep last 10 images', maxImageCount: 10 }],
        });
        // Dedicated bucket to receive S3 server access logs for the source bucket.
        // It logs to itself (terminal log bucket) so it also has access logging
        // enabled rather than being an un-logged bucket.
        const accessLogsBucket = new s3.Bucket(this, 'SourceBucketAccessLogs', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            // Self-logging: with a prefix but no separate target bucket, CDK
            // configures this bucket to deliver its own access logs to itself, so
            // every bucket in the stack has access logging enabled.
            serverAccessLogsPrefix: 'self-access-logs/',
            lifecycleRules: [
                { id: 'DeleteOldAccessLogs', enabled: true, expiration: cdk.Duration.days(90) },
            ],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });
        // S3 Bucket for CodeBuild source (buildspec + patch scripts)
        this.sourceBucket = new s3.Bucket(this, 'SourceBucket', {
            versioned: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            // Server access logging enabled (delivered to the dedicated log bucket).
            serverAccessLogsBucket: accessLogsBucket,
            serverAccessLogsPrefix: 'source-bucket-access-logs/',
            lifecycleRules: [
                { id: 'DeleteOldVersions', enabled: true, noncurrentVersionExpiration: cdk.Duration.days(30) },
            ],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });
        // Upload codebuild-scripts to S3
        const scriptsDeployment = new s3deploy.BucketDeployment(this, 'CodeBuildScriptsDeployment', {
            sources: [s3deploy.Source.asset(path.join(__dirname, '../../codebuild-scripts'), { exclude: exports.LOCAL_ARTIFACTS })],
            destinationBucket: this.sourceBucket,
            destinationKeyPrefix: 'codebuild-scripts/',
            extract: true,
            prune: false,
            retainOnDelete: false,
            memoryLimit: 512,
        });
        // Also upload agentcore directory for main runtime build
        const agentcoreDeployment = new s3deploy.BucketDeployment(this, 'AgentcoreSourceDeployment', {
            sources: [s3deploy.Source.asset(path.join(__dirname, '../../agentcore'), { exclude: exports.LOCAL_ARTIFACTS })],
            destinationBucket: this.sourceBucket,
            destinationKeyPrefix: 'agentcore/',
        });
        // Upload inventory MCP server source to S3
        const inventorySourceDeployment = new s3deploy.BucketDeployment(this, 'InventorySourceDeployment', {
            sources: [s3deploy.Source.asset(path.join(__dirname, '../../mcp-servers/inventory'), { exclude: exports.LOCAL_ARTIFACTS })],
            destinationBucket: this.sourceBucket,
            destinationKeyPrefix: 'inventory/',
        });
        // --- Build Trigger Lambda ---
        const buildTriggerFn = new lambda.Function(this, 'BuildTriggerFunction', {
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/build-trigger')),
            timeout: cdk.Duration.minutes(1),
            memorySize: 128,
            description: 'Triggers CodeBuild build for MCP server container',
        });
        // --- Build Waiter Lambda ---
        const buildWaiterFn = new lambda.Function(this, 'BuildWaiterFunction', {
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/build-waiter')),
            timeout: cdk.Duration.minutes(15),
            memorySize: 256,
            description: 'Polls CodeBuild build status until completion',
        });
        // ========================================
        // Billing MCP Server - CodeBuild + Transform
        // ========================================
        const billingBuildProject = this.createTransformBuildProject('BillingMcp', this.billingMcpRepository, 'codebuild-scripts/', 'buildspec-billing.yml');
        billingBuildProject.node.addDependency(scriptsDeployment);
        // Grant Lambda permissions
        buildTriggerFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:StartBuild'],
            resources: [billingBuildProject.projectArn],
        }));
        buildWaiterFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:BatchGetBuilds'],
            resources: [billingBuildProject.projectArn],
        }));
        // Trigger billing build
        const billingBuildTrigger = new cdk.CustomResource(this, 'BillingBuildTrigger', {
            serviceToken: buildTriggerFn.functionArn,
            properties: {
                ProjectName: billingBuildProject.projectName,
                Timestamp: new Date().toISOString(),
            },
        });
        billingBuildTrigger.node.addDependency(scriptsDeployment);
        // Wait for billing build
        const billingBuildWaiter = new cdk.CustomResource(this, 'BillingBuildWaiter', {
            serviceToken: buildWaiterFn.functionArn,
            properties: {
                BuildId: billingBuildTrigger.getAttString('BuildId'),
                MaxWaitSeconds: '1200',
            },
        });
        billingBuildWaiter.node.addDependency(billingBuildTrigger);
        // ========================================
        // Pricing MCP Server - CodeBuild + Transform
        // ========================================
        const pricingBuildProject = this.createTransformBuildProject('PricingMcp', this.pricingMcpRepository, 'codebuild-scripts/', 'buildspec-pricing.yml');
        pricingBuildProject.node.addDependency(scriptsDeployment);
        // Grant Lambda permissions for pricing
        buildTriggerFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:StartBuild'],
            resources: [pricingBuildProject.projectArn],
        }));
        buildWaiterFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:BatchGetBuilds'],
            resources: [pricingBuildProject.projectArn],
        }));
        // Trigger pricing build
        const pricingBuildTrigger = new cdk.CustomResource(this, 'PricingBuildTrigger', {
            serviceToken: buildTriggerFn.functionArn,
            properties: {
                ProjectName: pricingBuildProject.projectName,
                Timestamp: new Date().toISOString(),
            },
        });
        pricingBuildTrigger.node.addDependency(scriptsDeployment);
        // Wait for pricing build
        const pricingBuildWaiter = new cdk.CustomResource(this, 'PricingBuildWaiter', {
            serviceToken: buildWaiterFn.functionArn,
            properties: {
                BuildId: pricingBuildTrigger.getAttString('BuildId'),
                MaxWaitSeconds: '1200',
            },
        });
        pricingBuildWaiter.node.addDependency(pricingBuildTrigger);
        // ========================================
        // CloudWatch MCP Server - CodeBuild + Transform
        // ========================================
        const cloudwatchBuildProject = this.createTransformBuildProject('CloudWatchMcp', this.cloudwatchMcpRepository, 'codebuild-scripts/', 'buildspec-cloudwatch.yml');
        cloudwatchBuildProject.node.addDependency(scriptsDeployment);
        // Grant Lambda permissions for CloudWatch
        buildTriggerFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:StartBuild'],
            resources: [cloudwatchBuildProject.projectArn],
        }));
        buildWaiterFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:BatchGetBuilds'],
            resources: [cloudwatchBuildProject.projectArn],
        }));
        // Trigger CloudWatch build
        const cloudwatchBuildTrigger = new cdk.CustomResource(this, 'CloudWatchBuildTrigger', {
            serviceToken: buildTriggerFn.functionArn,
            properties: {
                ProjectName: cloudwatchBuildProject.projectName,
                Timestamp: new Date().toISOString(),
            },
        });
        cloudwatchBuildTrigger.node.addDependency(scriptsDeployment);
        // Wait for CloudWatch build
        const cloudwatchBuildWaiter = new cdk.CustomResource(this, 'CloudWatchBuildWaiter', {
            serviceToken: buildWaiterFn.functionArn,
            properties: {
                BuildId: cloudwatchBuildTrigger.getAttString('BuildId'),
                MaxWaitSeconds: '1200',
            },
        });
        cloudwatchBuildWaiter.node.addDependency(cloudwatchBuildTrigger);
        // ========================================
        // CloudTrail MCP Server - CodeBuild + Transform
        // ========================================
        const cloudtrailBuildProject = this.createTransformBuildProject('CloudTrailMcp', this.cloudtrailMcpRepository, 'codebuild-scripts/', 'buildspec-cloudtrail.yml');
        cloudtrailBuildProject.node.addDependency(scriptsDeployment);
        // Grant Lambda permissions for CloudTrail
        buildTriggerFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:StartBuild'],
            resources: [cloudtrailBuildProject.projectArn],
        }));
        buildWaiterFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:BatchGetBuilds'],
            resources: [cloudtrailBuildProject.projectArn],
        }));
        // Trigger CloudTrail build
        const cloudtrailBuildTrigger = new cdk.CustomResource(this, 'CloudTrailBuildTrigger', {
            serviceToken: buildTriggerFn.functionArn,
            properties: {
                ProjectName: cloudtrailBuildProject.projectName,
                Timestamp: new Date().toISOString(),
            },
        });
        cloudtrailBuildTrigger.node.addDependency(scriptsDeployment);
        // Wait for CloudTrail build
        const cloudtrailBuildWaiter = new cdk.CustomResource(this, 'CloudTrailBuildWaiter', {
            serviceToken: buildWaiterFn.functionArn,
            properties: {
                BuildId: cloudtrailBuildTrigger.getAttString('BuildId'),
                MaxWaitSeconds: '1200',
            },
        });
        cloudtrailBuildWaiter.node.addDependency(cloudtrailBuildTrigger);
        // ========================================
        // Inventory MCP Server - Direct Docker Build
        // ========================================
        const inventoryBuildRole = new iam.Role(this, 'InventoryMcpCodeBuildRole', {
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
            description: 'IAM role for CodeBuild to build Inventory MCP container image',
            inlinePolicies: {
                CloudWatchLogsPolicy: new iam.PolicyDocument({
                    statements: [new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                            resources: [`arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/codebuild/*`],
                        })],
                }),
                ECRPushPolicy: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: [
                                'ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage',
                                'ecr:PutImage', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload',
                            ],
                            resources: [this.inventoryMcpRepository.repositoryArn],
                        }),
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['ecr:GetAuthorizationToken'],
                            resources: ['*'],
                        }),
                    ],
                }),
                S3ReadPolicy: new iam.PolicyDocument({
                    statements: [new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['s3:GetObject', 's3:GetObjectVersion'],
                            resources: [this.sourceBucket.arnForObjects('*')],
                        })],
                }),
            },
        });
        const inventoryBuildProject = new codebuild.Project(this, 'InventoryMcpBuildProject', {
            projectName: 'cloudops-inventorymcp-build',
            description: 'Build ARM64 container for Inventory MCP server',
            source: codebuild.Source.s3({
                bucket: this.sourceBucket,
                path: 'inventory/',
            }),
            environment: {
                buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
                computeType: codebuild.ComputeType.SMALL,
                privileged: true,
                environmentVariables: {
                    AWS_DEFAULT_REGION: { value: cdk.Aws.REGION },
                    AWS_ACCOUNT_ID: { value: cdk.Aws.ACCOUNT_ID },
                    ECR_REPO_URI: { value: this.inventoryMcpRepository.repositoryUri },
                },
            },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    pre_build: {
                        commands: [
                            'echo "=== Phase Pre-build - ECR Login ==="',
                            'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com',
                        ],
                    },
                    build: {
                        commands: [
                            'echo "=== Phase Build - Docker image ==="',
                            'docker build -t $ECR_REPO_URI:$CODEBUILD_BUILD_NUMBER .',
                            'docker tag $ECR_REPO_URI:$CODEBUILD_BUILD_NUMBER $ECR_REPO_URI:latest',
                        ],
                    },
                    post_build: {
                        commands: [
                            'echo "=== Phase Post-build - Push to ECR ==="',
                            'docker push $ECR_REPO_URI:$CODEBUILD_BUILD_NUMBER',
                            'docker push $ECR_REPO_URI:latest',
                            'echo "Inventory MCP image pushed successfully."',
                        ],
                    },
                },
            }),
            role: inventoryBuildRole,
            timeout: cdk.Duration.minutes(30),
        });
        inventoryBuildProject.node.addDependency(inventorySourceDeployment);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(inventoryBuildRole, [
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard for ecr:GetAuthorizationToken, S3, CloudWatch Logs.' },
        ], true);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(inventoryBuildProject, [
            { id: 'AwsSolutions-CB4', reason: 'KMS encryption not enabled for dev/demo.' },
        ]);
        // Grant Lambda permissions for Inventory
        buildTriggerFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:StartBuild'],
            resources: [inventoryBuildProject.projectArn],
        }));
        buildWaiterFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:BatchGetBuilds'],
            resources: [inventoryBuildProject.projectArn],
        }));
        // Trigger Inventory build
        const inventoryBuildTrigger = new cdk.CustomResource(this, 'InventoryBuildTrigger', {
            serviceToken: buildTriggerFn.functionArn,
            properties: {
                ProjectName: inventoryBuildProject.projectName,
                Timestamp: new Date().toISOString(),
            },
        });
        inventoryBuildTrigger.node.addDependency(inventorySourceDeployment);
        // Wait for Inventory build
        const inventoryBuildWaiter = new cdk.CustomResource(this, 'InventoryBuildWaiter', {
            serviceToken: buildWaiterFn.functionArn,
            properties: {
                BuildId: inventoryBuildTrigger.getAttString('BuildId'),
                MaxWaitSeconds: '1200',
            },
        });
        inventoryBuildWaiter.node.addDependency(inventoryBuildTrigger);
        // ========================================
        // Main Agent Runtime - Standard Docker Build
        // ========================================
        this.buildMainRuntimeImage(agentcoreDeployment);
        // ========================================
        // Outputs
        // ========================================
        new cdk.CfnOutput(this, 'MainRepositoryUri', {
            value: this.repository.repositoryUri,
            description: 'Main Runtime ECR Repository URI',
            exportName: `${this.stackName}-MainRepositoryUri`,
        });
        new cdk.CfnOutput(this, 'BillingMcpRepositoryUri', {
            value: this.billingMcpRepository.repositoryUri,
            description: 'Billing MCP Runtime ECR Repository URI',
            exportName: `${this.stackName}-BillingMcpRepositoryUri`,
        });
        new cdk.CfnOutput(this, 'PricingMcpRepositoryUri', {
            value: this.pricingMcpRepository.repositoryUri,
            description: 'Pricing MCP Runtime ECR Repository URI',
            exportName: `${this.stackName}-PricingMcpRepositoryUri`,
        });
        new cdk.CfnOutput(this, 'CloudWatchMcpRepositoryUri', {
            value: this.cloudwatchMcpRepository.repositoryUri,
            description: 'CloudWatch MCP Runtime ECR Repository URI',
            exportName: `${this.stackName}-CloudWatchMcpRepositoryUri`,
        });
        new cdk.CfnOutput(this, 'CloudTrailMcpRepositoryUri', {
            value: this.cloudtrailMcpRepository.repositoryUri,
            description: 'CloudTrail MCP Runtime ECR Repository URI',
            exportName: `${this.stackName}-CloudTrailMcpRepositoryUri`,
        });
        new cdk.CfnOutput(this, 'InventoryMcpRepositoryUri', {
            value: this.inventoryMcpRepository.repositoryUri,
            description: 'Inventory MCP Runtime ECR Repository URI',
            exportName: `${this.stackName}-InventoryMcpRepositoryUri`,
        });
        new cdk.CfnOutput(this, 'SourceBucketName', {
            value: this.sourceBucket.bucketName,
            description: 'S3 bucket for CodeBuild source scripts',
        });
        // ========================================
        // CDK-Nag Suppressions
        // ========================================
        cdk_nag_1.NagSuppressions.addResourceSuppressions(accessLogsBucket, [
            { id: 'AwsSolutions-S1', reason: 'Terminal access-log bucket; it logs to itself (serverAccessLogsPrefix set), so access logging is enabled.' },
        ]);
        cdk_nag_1.NagSuppressions.addStackSuppressions(this, [
            { id: 'AwsSolutions-L1', reason: 'Lambda runtime version managed by CDK.' },
            { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is AWS best practice.' },
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard permissions required for S3, ECR, CloudWatch, CodeBuild.' },
            { id: 'AwsSolutions-CB4', reason: 'KMS encryption not enabled for dev/demo.' },
        ]);
    }
    /**
     * Create a CodeBuild project that clones upstream MCP repo,
     * applies patch scripts, builds ARM64 Docker image,
     * and pushes to ECR.
     */
    createTransformBuildProject(id, repository, sourcePath, buildspecFile) {
        const codeBuildRole = new iam.Role(this, `${id}CodeBuildRole`, {
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
            description: `IAM role for CodeBuild to build ${id} container image`,
            inlinePolicies: {
                CloudWatchLogsPolicy: new iam.PolicyDocument({
                    statements: [new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                            resources: [`arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/codebuild/*`],
                        })],
                }),
                ECRPushPolicy: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: [
                                'ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage',
                                'ecr:PutImage', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload',
                            ],
                            resources: [repository.repositoryArn],
                        }),
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['ecr:GetAuthorizationToken'],
                            resources: ['*'],
                        }),
                    ],
                }),
                S3ReadPolicy: new iam.PolicyDocument({
                    statements: [new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['s3:GetObject', 's3:GetObjectVersion'],
                            resources: [this.sourceBucket.arnForObjects('*')],
                        })],
                }),
            },
        });
        const project = new codebuild.Project(this, `${id}BuildProject`, {
            projectName: `cloudops-${id.toLowerCase()}-build`,
            description: `Build ARM64 container for ${id} with streamable-http transport`,
            source: codebuild.Source.s3({
                bucket: this.sourceBucket,
                path: sourcePath,
            }),
            buildSpec: codebuild.BuildSpec.fromSourceFilename(buildspecFile),
            environment: {
                buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
                computeType: codebuild.ComputeType.SMALL,
                privileged: true,
                environmentVariables: {
                    AWS_DEFAULT_REGION: { value: cdk.Aws.REGION },
                    AWS_ACCOUNT_ID: { value: cdk.Aws.ACCOUNT_ID },
                    ECR_REPO_URI: { value: repository.repositoryUri },
                },
            },
            role: codeBuildRole,
            timeout: cdk.Duration.minutes(30),
        });
        cdk_nag_1.NagSuppressions.addResourceSuppressions(codeBuildRole, [
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard for ecr:GetAuthorizationToken, S3, CloudWatch Logs.' },
        ], true);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(project, [
            { id: 'AwsSolutions-CB4', reason: 'KMS encryption not enabled for dev/demo.' },
        ]);
        return project;
    }
    /**
     * Build the main agent runtime image using standard Docker build
     * (no patching needed - it's our own code).
     */
    buildMainRuntimeImage(sourceDeployment) {
        const buildProject = new codebuild.Project(this, 'MainRuntimeBuildProject', {
            projectName: 'cloudops-mainruntime-build',
            source: codebuild.Source.s3({
                bucket: this.sourceBucket,
                path: 'agentcore/',
            }),
            environment: {
                buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_ARM_3,
                privileged: true,
                computeType: codebuild.ComputeType.SMALL,
            },
            environmentVariables: {
                AWS_DEFAULT_REGION: { value: this.region },
                AWS_ACCOUNT_ID: { value: this.account },
                IMAGE_REPO_NAME: { value: this.repository.repositoryName },
                IMAGE_TAG: { value: 'latest' },
            },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    pre_build: {
                        commands: [
                            'echo Logging in to Amazon ECR...',
                            'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com',
                        ],
                    },
                    build: {
                        commands: [
                            'echo Building the Docker image...',
                            'docker build -t $IMAGE_REPO_NAME:$IMAGE_TAG .',
                            'docker tag $IMAGE_REPO_NAME:$IMAGE_TAG $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG',
                        ],
                    },
                    post_build: {
                        commands: [
                            'echo Pushing the Docker image...',
                            'docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG',
                        ],
                    },
                },
            }),
        });
        this.repository.grantPullPush(buildProject);
        this.sourceBucket.grantRead(buildProject);
        buildProject.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ecr:GetAuthorizationToken'],
            resources: ['*'],
        }));
        const triggerFn = new cdk.aws_lambda.Function(this, 'MainRuntimeBuildTriggerFn', {
            runtime: cdk.aws_lambda.Runtime.PYTHON_3_14,
            handler: 'index.handler',
            code: cdk.aws_lambda.Code.fromAsset(path.join(__dirname, '../../lambda/build-trigger')),
            timeout: cdk.Duration.minutes(1),
        });
        triggerFn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:StartBuild'],
            resources: [buildProject.projectArn],
        }));
        triggerFn.node.addDependency(sourceDeployment);
        new cdk.CustomResource(this, 'MainRuntimeTriggerBuild', {
            serviceToken: triggerFn.functionArn,
            properties: {
                ProjectName: buildProject.projectName,
                Timestamp: `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`,
            },
        });
        cdk_nag_1.NagSuppressions.addResourceSuppressions(buildProject, [
            { id: 'AwsSolutions-CB4', reason: 'KMS encryption not enabled for dev/demo.' },
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard for ECR, S3, CloudWatch.' },
        ], true);
    }
}
exports.ImageStack = ImageStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW1hZ2Utc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbWFnZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMseURBQTJDO0FBQzNDLHFFQUF1RDtBQUN2RCx5REFBMkM7QUFDM0MsdURBQXlDO0FBQ3pDLHdFQUEwRDtBQUMxRCwrREFBaUQ7QUFFakQsK0NBQWlDO0FBQ2pDLDJDQUE2QjtBQUM3QixxQ0FBMEM7QUFFMUMsNkVBQTZFO0FBQzdFLDhFQUE4RTtBQUM5RSw2RUFBNkU7QUFDN0UsNEVBQTRFO0FBQzVFLDJFQUEyRTtBQUMzRSxvQkFBb0I7QUFDUCxRQUFBLGVBQWUsR0FBRztJQUM3QixjQUFjO0lBQ2QsT0FBTztJQUNQLGFBQWE7SUFDYixlQUFlO0lBQ2YsYUFBYTtJQUNiLE9BQU87Q0FDUixDQUFDO0FBRUY7Ozs7Ozs7Ozs7OztHQVlHO0FBQ0gsTUFBYSxVQUFXLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFTdkMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4Qiw4Q0FBOEM7UUFDOUMsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLEdBQUcsQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLG1CQUFtQixFQUFFO1lBQzlELGNBQWMsRUFBRSx3QkFBd0I7WUFDeEMsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztZQUN4QyxhQUFhLEVBQUUsSUFBSTtZQUNuQixlQUFlLEVBQUUsSUFBSTtZQUNyQixjQUFjLEVBQUUsQ0FBQyxFQUFFLFdBQVcsRUFBRSxxQkFBcUIsRUFBRSxhQUFhLEVBQUUsRUFBRSxFQUFFLENBQUM7U0FDNUUsQ0FBQyxDQUFDO1FBRUgsZ0RBQWdEO1FBQ2hELElBQUksQ0FBQyxvQkFBb0Is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QUFDO1FBRS9DLElBQUksR0FBRyxDQUFDLGNBQWMsQ0FBQyxJQUFJLEVBQUUseUJBQXlCLEVBQUU7WUFDdEQsWUFBWSxFQUFFLFNBQVMsQ0FBQyxXQUFXO1lBQ25DLFVBQVUsRUFBRTtnQkFDVixXQUFXLEVBQUUsWUFBWSxDQUFDLFdBQVc7Z0JBQ3JDLFNBQVMsRUFBRSxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsSUFBSSxNQUFNLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsRUFBRTthQUNwRTtTQUNGLENBQUMsQ0FBQztRQUVILHlCQUFlLENBQUMsdUJBQXVCLENBQUMsWUFBWSxFQUFFO1lBQ3BELEVBQUUsRUFBRSxFQUFFLGtCQUFrQixFQUFFLE1BQU0sRUFBRSwwQ0FBMEMsRUFBRTtZQUM5RSxFQUFFLEVBQUUsRUFBRSxtQkFBbUIsRUFBRSxNQUFNLEVBQUUsbUNBQW1DLEVBQUU7U0FDekUsRUFBRSxJQUFJLENBQUMsQ0FBQztJQUNYLENBQUM7Q0FDRjtBQWxxQkQsZ0NBa3FCQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgKiBhcyBjb2RlYnVpbGQgZnJvbSAnYXdzLWNkay1saWIvYXdzLWNvZGVidWlsZCc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xuaW1wb3J0ICogYXMgczNkZXBsb3kgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzLWRlcGxveW1lbnQnO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBjcnlwdG8gZnJvbSAnY3J5cHRvJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBOYWdTdXBwcmVzc2lvbnMgfSBmcm9tICdjZGstbmFnJztcblxuLy8gTG9jYWwtb25seSBidWlsZCBhcnRpZmFjdHMgdGhhdCBtdXN0IG5ldmVyIGVudGVyIGEgQ29kZUJ1aWxkIHNvdXJjZSBhc3NldC5cbi8vIEEgZGV2ZWxvcGVyIGB1diBzeW5jYCBsZWF2ZXMgYSB+NjAgTUIgLyAzLjdrLWZpbGUgLnZlbnYgaW4gdGhlIHNvdXJjZSB0cmVlO1xuLy8gQnVja2V0RGVwbG95bWVudCB0aGVuIHVwbG9hZHMgaXQgb2JqZWN0LWJ5LW9iamVjdCBhbmQgdGltZXMgb3V0LiBTYW1lIGxpc3Rcbi8vIGFzIHNjcmlwdHMvbWFrZS9wbGFuLWhhc2guc2guIEJhcmUgbmFtZXMgbWF0Y2ggYXQgYW55IGRlcHRoIGFuZCBwcnVuZSB0aGVcbi8vIHdob2xlIGRpcmVjdG9yeTsgYGRpci8qKmAgd291bGQgbm90LCBiZWNhdXNlIGAqKmAgc2tpcHMgZG90ZmlsZXMgc3VjaCBhc1xuLy8gLnZlbnYvLmdpdGlnbm9yZS5cbmV4cG9ydCBjb25zdCBMT0NBTF9BUlRJRkFDVFMgPSBbXG4gICdub2RlX21vZHVsZXMnLFxuICAnLnZlbnYnLFxuICAnX19weWNhY2hlX18nLFxuICAnLnB5dGVzdF9jYWNoZScsXG4gICcuaHlwb3RoZXNpcycsXG4gICcqLnB5YycsXG5dO1xuXG4vKipcbiAqIEltYWdlU3RhY2s6IEJ1aWxkcyBEb2NrZXIgaW1hZ2VzIGZvciBNQ1Agc2VydmVyIHJ1bnRpbWVzIHVzaW5nIHRoZVxuICogc3RkaW8tdG8tSFRUUCBwYXRjaGluZyBwYXR0ZXJuLlxuICpcbiAqIEZvciBlYWNoIE1DUCBzZXJ2ZXIgKGJpbGxpbmcsIHByaWNpbmcpOlxuICogICAxLiBDb2RlQnVpbGQgY2xvbmVzIHRoZSB1cHN0cmVhbSBBV1MgTGFicyBNQ1AgcmVwb1xuICogICAyLiBwYXRjaC17c2VydmVyfS5zaCBwYXRjaGVzIHNlcnZlci5weSBmb3Igc3RyZWFtYWJsZS1odHRwIHRyYW5zcG9ydFxuICogICAzLiBBZGRzIHV2aWNvcm4gKyBzdGFybGV0dGUgZGVwZW5kZW5jaWVzXG4gKiAgIDQuIFBhdGNoZXMgRG9ja2VyZmlsZSAoRVhQT1NFIDgwMDAsIGVudHJ5cG9pbnQsIGhlYWx0aGNoZWNrKVxuICogICA1LiBCdWlsZHMgQVJNNjQgRG9ja2VyIGltYWdlIGFuZCBwdXNoZXMgdG8gRUNSXG4gKlxuICogQmFzZWQgb246IGh0dHBzOi8vZ2l0aHViLmNvbS9hd3Mtc2FtcGxlcy9zYW1wbGUtYXdzLXN0ZGlvLWh0dHAtcHJveHktbWNwXG4gKi9cbmV4cG9ydCBjbGFzcyBJbWFnZVN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IHJlcG9zaXRvcnk6IGVjci5SZXBvc2l0b3J5O1xuICBwdWJsaWMgcmVhZG9ubHkgYmlsbGluZ01jcFJlcG9zaXRvcnk6IGVjci5SZXBvc2l0b3J5O1xuICBwdWJsaWMgcmVhZG9ubHkgcHJpY2luZ01jcFJlcG9zaXRvcnk6IGVjci5SZXBvc2l0b3J5O1xuICBwdWJsaWMgcmVhZG9ubHkgY2xvdWR3YXRjaE1jcFJlcG9zaXRvcnk6IGVjci5SZXBvc2l0b3J5O1xuICBwdWJsaWMgcmVhZG9ubHkgY2xvdWR0cmFpbE1jcFJlcG9zaXRvcnk6IGVjci5SZXBvc2l0b3J5O1xuICBwdWJsaWMgcmVhZG9ubHkgaW52ZW50b3J5TWNwUmVwb3NpdG9yeTogZWNyLlJlcG9zaXRvcnk7XG4gIHB1YmxpYyByZWFkb25seSBzb3VyY2VCdWNrZXQ6IHMzLkJ1Y2tldDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyBFQ1IgUmVwb3NpdG9yeSBmb3IgTWFpbiBBZ2VudCBSdW50aW1lIGltYWdlXG4gICAgdGhpcy5yZXBvc2l0b3J5ID0gbmV3IGVjci5SZXBvc2l0b3J5KHRoaXMsICdSdW50aW1lUmVwb3NpdG9yeScsIHtcbiAgICAgIHJlcG9zaXRvcnlOYW1lOiAnY2xvdWRvcHMtYWdlbnQtcnVudGltZScsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgZW1wdHlPbkRlbGV0ZTogdHJ1ZSxcbiAgICAgIGltYWdlU2Nhbk9uUHVzaDogdHJ1ZSxcbiAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbeyBkZXNjcmlwdGlvbjogJ0tlZXAgbGFzdCAxMCBpbWFnZXMnLCBtYXhJbWFnZUNvdW50OiAxMCB9XSxcbiAgICB9KTtcblxuICAgIC8vIEVDUiBSZXBvc2l0b3J5IGZvciBCaWxsaW5nIE1DUCBTZXJ2ZXIgUnVudGltZVxuICAgIHRoaXMuYmlsbGluZ01jcFJlcG9zaXRvcnkgPSBuZXcgZWNyLlJlcG9zaXRvcnkodGhpcywgJ0JpbGxpbmdNY3BSZXBvc2l0b3J5Jywge1xuICAgICAgcmVwb3NpdG9yeU5hbWU6ICdjbG91ZG9wcy1iaWxsaW5nLW1jcC1ydW50aW1lJyxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICBlbXB0eU9uRGVsZXRlOiB0cnVlLFxuICAgICAgaW1hZ2VTY2FuT25QdXNoOiB0cnVlLFxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFt7IGRlc2NyaXB0aW9uOiAnS2VlcCBsYXN0IDEwIGltYWdlcycsIG1heEltYWdlQ291bnQ6IDEwIH1dLFxuICAgIH0pO1xuXG4gICAgLy8gRUNSIFJlcG9zaXRvcnkgZm9yIFByaWNpbmcgTUNQIFNlcnZlciBSdW50aW1lXG4gICAgdGhpcy5wcmljaW5nTWNwUmVwb3NpdG9yeSA9IG5ldyBlY3IuUmVwb3NpdG9yeSh0aGlzLCAnUHJpY2luZ01jcFJlcG9zaXRvcnknLCB7XG4gICAgICByZXBvc2l0b3J5TmFtZTogJ2Nsb3Vkb3BzLXByaWNpbmctbWNwLXJ1bnRpbWUnLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGVtcHR5T25EZWxldGU6IHRydWUsXG4gICAgICBpbWFnZVNjYW5PblB1c2g6IHRydWUsXG4gICAgICBsaWZlY3ljbGVSdWxlczogW3sgZGVzY3JpcHRpb246ICdLZWVwIGxhc3QgMTAgaW1hZ2VzJywgbWF4SW1hZ2VDb3VudDogMTAgfV0sXG4gICAgfSk7XG5cbiAgICAvLyBFQ1IgUmVwb3NpdG9yeSBmb3IgQ2xvdWRXYXRjaCBNQ1AgU2VydmVyIFJ1bnRpbWVcbiAgICB0aGlzLmNsb3Vkd2F0Y2hNY3BSZXBvc2l0b3J5ID0gbmV3IGVjci5SZXBvc2l0b3J5KHRoaXMsICdDbG91ZFdhdGNoTWNwUmVwb3NpdG9yeScsIHtcbiAgICAgIHJlcG9zaXRvcnlOYW1lOiAnY2xvdWRvcHMtY2xvdWR3YXRjaC1tY3AtcnVudGltZScsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgZW1wdHlPbkRlbGV0ZTogdHJ1ZSxcbiAgICAgIGltYWdlU2Nhbk9uUHVzaDogdHJ1ZSxcbiAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbeyBkZXNjcmlwdGlvbjogJ0tlZXAgbGFzdCAxMCBpbWFnZXMnLCBtYXhJbWFnZUNvdW50OiAxMCB9XSxcbiAgICB9KTtcblxuICAgIC8vIEVDUiBSZXBvc2l0b3J5IGZvciBDbG91ZFRyYWlsIE1DUCBTZXJ2ZXIgUnVudGltZVxuICAgIHRoaXMuY2xvdWR0cmFpbE1jcFJlcG9zaXRvcnkgPSBuZXcgZWNyLlJlcG9zaXRvcnkodGhpcywgJ0Nsb3VkVHJhaWxNY3BSZXBvc2l0b3J5Jywge1xuICAgICAgcmVwb3NpdG9yeU5hbWU6ICdjbG91ZG9wcy1jbG91ZHRyYWlsLW1jcC1ydW50aW1lJyxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICBlbXB0eU9uRGVsZXRlOiB0cnVlLFxuICAgICAgaW1hZ2VTY2FuT25QdXNoOiB0cnVlLFxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFt7IGRlc2NyaXB0aW9uOiAnS2VlcCBsYXN0IDEwIGltYWdlcycsIG1heEltYWdlQ291bnQ6IDEwIH1dLFxuICAgIH0pO1xuXG4gICAgLy8gRUNSIFJlcG9zaXRvcnkgZm9yIEludmVudG9yeSBNQ1AgU2VydmVyIFJ1bnRpbWVcbiAgICB0aGlzLmludmVudG9yeU1jcFJlcG9zaXRvcnkgPSBuZXcgZWNyLlJlcG9zaXRvcnkodGhpcywgJ0ludmVudG9yeU1jcFJlcG9zaXRvcnknLCB7XG4gICAgICByZXBvc2l0b3J5TmFtZTogJ2Nsb3Vkb3BzLWludmVudG9yeS1tY3AtcnVudGltZScsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgZW1wdHlPbkRlbGV0ZTogdHJ1ZSxcbiAgICAgIGltYWdlU2Nhbk9uUHVzaDogdHJ1ZSxcbiAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbeyBkZXNjcmlwdGlvbjogJ0tlZXAgbGFzdCAxMCBpbWFnZXMnLCBtYXhJbWFnZUNvdW50OiAxMCB9XSxcbiAgICB9KTtcblxuICAgIC8vIERlZGljYXRlZCBidWNrZXQgdG8gcmVjZWl2ZSBTMyBzZXJ2ZXIgYWNjZXNzIGxvZ3MgZm9yIHRoZSBzb3VyY2UgYnVja2V0LlxuICAgIC8vIEl0IGxvZ3MgdG8gaXRzZWxmICh0ZXJtaW5hbCBsb2cgYnVja2V0KSBzbyBpdCBhbHNvIGhhcyBhY2Nlc3MgbG9nZ2luZ1xuICAgIC8vIGVuYWJsZWQgcmF0aGVyIHRoYW4gYmVpbmcgYW4gdW4tbG9nZ2VkIGJ1Y2tldC5cbiAgICBjb25zdCBhY2Nlc3NMb2dzQnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnU291cmNlQnVja2V0QWNjZXNzTG9ncycsIHtcbiAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgLy8gU2VsZi1sb2dnaW5nOiB3aXRoIGEgcHJlZml4IGJ1dCBubyBzZXBhcmF0ZSB0YXJnZXQgYnVja2V0LCBDREtcbiAgICAgIC8vIGNvbmZpZ3VyZXMgdGhpcyBidWNrZXQgdG8gZGVsaXZlciBpdHMgb3duIGFjY2VzcyBsb2dzIHRvIGl0c2VsZiwgc29cbiAgICAgIC8vIGV2ZXJ5IGJ1Y2tldCBpbiB0aGUgc3RhY2sgaGFzIGFjY2VzcyBsb2dnaW5nIGVuYWJsZWQuXG4gICAgICBzZXJ2ZXJBY2Nlc3NMb2dzUHJlZml4OiAnc2VsZi1hY2Nlc3MtbG9ncy8nLFxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFtcbiAgICAgICAgeyBpZDogJ0RlbGV0ZU9sZEFjY2Vzc0xvZ3MnLCBlbmFibGVkOiB0cnVlLCBleHBpcmF0aW9uOiBjZGsuRHVyYXRpb24uZGF5cyg5MCkgfSxcbiAgICAgIF0sXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBTMyBCdWNrZXQgZm9yIENvZGVCdWlsZCBzb3VyY2UgKGJ1aWxkc3BlYyArIHBhdGNoIHNjcmlwdHMpXG4gICAgdGhpcy5zb3VyY2VCdWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsICdTb3VyY2VCdWNrZXQnLCB7XG4gICAgICB2ZXJzaW9uZWQ6IHRydWUsXG4gICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgIC8vIFNlcnZlciBhY2Nlc3MgbG9nZ2luZyBlbmFibGVkIChkZWxpdmVyZWQgdG8gdGhlIGRlZGljYXRlZCBsb2cgYnVja2V0KS5cbiAgICAgIHNlcnZlckFjY2Vzc0xvZ3NCdWNrZXQ6IGFjY2Vzc0xvZ3NCdWNrZXQsXG4gICAgICBzZXJ2ZXJBY2Nlc3NMb2dzUHJlZml4OiAnc291cmNlLWJ1Y2tldC1hY2Nlc3MtbG9ncy8nLFxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFtcbiAgICAgICAgeyBpZDogJ0RlbGV0ZU9sZFZlcnNpb25zJywgZW5hYmxlZDogdHJ1ZSwgbm9uY3VycmVudFZlcnNpb25FeHBpcmF0aW9uOiBjZGsuRHVyYXRpb24uZGF5cygzMCkgfSxcbiAgICAgIF0sXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBVcGxvYWQgY29kZWJ1aWxkLXNjcmlwdHMgdG8gUzNcbiAgICBjb25zdCBzY3JpcHRzRGVwbG95bWVudCA9IG5ldyBzM2RlcGxveS5CdWNrZXREZXBsb3ltZW50KHRoaXMsICdDb2RlQnVpbGRTY3JpcHRzRGVwbG95bWVudCcsIHtcbiAgICAgIHNvdXJjZXM6IFtzM2RlcGxveS5Tb3VyY2UuYXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uLy4uL2NvZGVidWlsZC1zY3JpcHRzJyksIHsgZXhjbHVkZTogTE9DQUxfQVJUSUZBQ1RTIH0pXSxcbiAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiB0aGlzLnNvdXJjZUJ1Y2tldCxcbiAgICAgIGRlc3RpbmF0aW9uS2V5UHJlZml4OiAnY29kZWJ1aWxkLXNjcmlwdHMvJyxcbiAgICAgIGV4dHJhY3Q6IHRydWUsXG4gICAgICBwcnVuZTogZmFsc2UsXG4gICAgICByZXRhaW5PbkRlbGV0ZTogZmFsc2UsXG4gICAgICBtZW1vcnlMaW1pdDogNTEyLFxuICAgIH0pO1xuXG4gICAgLy8gQWxzbyB1cGxvYWQgYWdlbnRjb3JlIGRpcmVjdG9yeSBmb3IgbWFpbiBydW50aW1lIGJ1aWxkXG4gICAgY29uc3QgYWdlbnRjb3JlRGVwbG95bWVudCA9IG5ldyBzM2RlcGxveS5CdWNrZXREZXBsb3ltZW50KHRoaXMsICdBZ2VudGNvcmVTb3VyY2VEZXBsb3ltZW50Jywge1xuICAgICAgc291cmNlczogW3MzZGVwbG95LlNvdXJjZS5hc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vLi4vYWdlbnRjb3JlJyksIHsgZXhjbHVkZTogTE9DQUxfQVJUSUZBQ1RTIH0pXSxcbiAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiB0aGlzLnNvdXJjZUJ1Y2tldCxcbiAgICAgIGRlc3RpbmF0aW9uS2V5UHJlZml4OiAnYWdlbnRjb3JlLycsXG4gICAgfSk7XG5cbiAgICAvLyBVcGxvYWQgaW52ZW50b3J5IE1DUCBzZXJ2ZXIgc291cmNlIHRvIFMzXG4gICAgY29uc3QgaW52ZW50b3J5U291cmNlRGVwbG95bWVudCA9IG5ldyBzM2RlcGxveS5CdWNrZXREZXBsb3ltZW50KHRoaXMsICdJbnZlbnRvcnlTb3VyY2VEZXBsb3ltZW50Jywge1xuICAgICAgc291cmNlczogW3MzZGVwbG95LlNvdXJjZS5hc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vLi4vbWNwLXNlcnZlcnMvaW52ZW50b3J5JyksIHsgZXhjbHVkZTogTE9DQUxfQVJUSUZBQ1RTIH0pXSxcbiAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiB0aGlzLnNvdXJjZUJ1Y2tldCxcbiAgICAgIGRlc3RpbmF0aW9uS2V5UHJlZml4OiAnaW52ZW50b3J5LycsXG4gICAgfSk7XG5cbiAgICAvLyAtLS0gQnVpbGQgVHJpZ2dlciBMYW1iZGEgLS0tXG4gICAgY29uc3QgYnVpbGRUcmlnZ2VyRm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdCdWlsZFRyaWdnZXJGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzE0LFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi8uLi9sYW1iZGEvYnVpbGQtdHJpZ2dlcicpKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDEpLFxuICAgICAgbWVtb3J5U2l6ZTogMTI4LFxuICAgICAgZGVzY3JpcHRpb246ICdUcmlnZ2VycyBDb2RlQnVpbGQgYnVpbGQgZm9yIE1DUCBzZXJ2ZXIgY29udGFpbmVyJyxcbiAgICB9KTtcblxuICAgIC8vIC0tLSBCdWlsZCBXYWl0ZXIgTGFtYmRhIC0tLVxuICAgIGNvbnN0IGJ1aWxkV2FpdGVyRm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdCdWlsZFdhaXRlckZ1bmN0aW9uJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTQsXG4gICAgICBoYW5kbGVyOiAnaW5kZXguaGFuZGxlcicsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uLy4uL2xhbWJkYS9idWlsZC13YWl0ZXInKSksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygxNSksXG4gICAgICBtZW1vcnlTaXplOiAyNTYsXG4gICAgICBkZXNjcmlwdGlvbjogJ1BvbGxzIENvZGVCdWlsZCBidWlsZCBzdGF0dXMgdW50aWwgY29tcGxldGlvbicsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQmlsbGluZyBNQ1AgU2VydmVyIC0gQ29kZUJ1aWxkICsgVHJhbnNmb3JtXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGJpbGxpbmdCdWlsZFByb2plY3QgPSB0aGlzLmNyZWF0ZVRyYW5zZm9ybUJ1aWxkUHJvamVjdChcbiAgICAgICdCaWxsaW5nTWNwJyxcbiAgICAgIHRoaXMuYmlsbGluZ01jcFJlcG9zaXRvcnksXG4gICAgICAnY29kZWJ1aWxkLXNjcmlwdHMvJyxcbiAgICAgICdidWlsZHNwZWMtYmlsbGluZy55bWwnLFxuICAgICk7XG4gICAgYmlsbGluZ0J1aWxkUHJvamVjdC5ub2RlLmFkZERlcGVuZGVuY3koc2NyaXB0c0RlcGxveW1lbnQpO1xuXG4gICAgLy8gR3JhbnQgTGFtYmRhIHBlcm1pc3Npb25zXG4gICAgYnVpbGRUcmlnZ2VyRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnY29kZWJ1aWxkOlN0YXJ0QnVpbGQnXSxcbiAgICAgIHJlc291cmNlczogW2JpbGxpbmdCdWlsZFByb2plY3QucHJvamVjdEFybl0sXG4gICAgfSkpO1xuICAgIGJ1aWxkV2FpdGVyRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnY29kZWJ1aWxkOkJhdGNoR2V0QnVpbGRzJ10sXG4gICAgICByZXNvdXJjZXM6IFtiaWxsaW5nQnVpbGRQcm9qZWN0LnByb2plY3RBcm5dLFxuICAgIH0pKTtcblxuICAgIC8vIFRyaWdnZXIgYmlsbGluZyBidWlsZFxuICAgIGNvbnN0IGJpbGxpbmdCdWlsZFRyaWdnZXIgPSBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdCaWxsaW5nQnVpbGRUcmlnZ2VyJywge1xuICAgICAgc2VydmljZVRva2VuOiBidWlsZFRyaWdnZXJGbi5mdW5jdGlvbkFybixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgUHJvamVjdE5hbWU6IGJpbGxpbmdCdWlsZFByb2plY3QucHJvamVjdE5hbWUsXG4gICAgICAgIFRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBiaWxsaW5nQnVpbGRUcmlnZ2VyLm5vZGUuYWRkRGVwZW5kZW5jeShzY3JpcHRzRGVwbG95bWVudCk7XG5cbiAgICAvLyBXYWl0IGZvciBiaWxsaW5nIGJ1aWxkXG4gICAgY29uc3QgYmlsbGluZ0J1aWxkV2FpdGVyID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnQmlsbGluZ0J1aWxkV2FpdGVyJywge1xuICAgICAgc2VydmljZVRva2VuOiBidWlsZFdhaXRlckZuLmZ1bmN0aW9uQXJuLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBCdWlsZElkOiBiaWxsaW5nQnVpbGRUcmlnZ2VyLmdldEF0dFN0cmluZygnQnVpbGRJZCcpLFxuICAgICAgICBNYXhXYWl0U2Vjb25kczogJzEyMDAnLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBiaWxsaW5nQnVpbGRXYWl0ZXIubm9kZS5hZGREZXBlbmRlbmN5KGJpbGxpbmdCdWlsZFRyaWdnZXIpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFByaWNpbmcgTUNQIFNlcnZlciAtIENvZGVCdWlsZCArIFRyYW5zZm9ybVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBwcmljaW5nQnVpbGRQcm9qZWN0ID0gdGhpcy5jcmVhdGVUcmFuc2Zvcm1CdWlsZFByb2plY3QoXG4gICAgICAnUHJpY2luZ01jcCcsXG4gICAgICB0aGlzLnByaWNpbmdNY3BSZXBvc2l0b3J5LFxuICAgICAgJ2NvZGVidWlsZC1zY3JpcHRzLycsXG4gICAgICAnYnVpbGRzcGVjLXByaWNpbmcueW1sJyxcbiAgICApO1xuICAgIHByaWNpbmdCdWlsZFByb2plY3Qubm9kZS5hZGREZXBlbmRlbmN5KHNjcmlwdHNEZXBsb3ltZW50KTtcblxuICAgIC8vIEdyYW50IExhbWJkYSBwZXJtaXNzaW9ucyBmb3IgcHJpY2luZ1xuICAgIGJ1aWxkVHJpZ2dlckZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2NvZGVidWlsZDpTdGFydEJ1aWxkJ10sXG4gICAgICByZXNvdXJjZXM6IFtwcmljaW5nQnVpbGRQcm9qZWN0LnByb2plY3RBcm5dLFxuICAgIH0pKTtcbiAgICBidWlsZFdhaXRlckZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2NvZGVidWlsZDpCYXRjaEdldEJ1aWxkcyddLFxuICAgICAgcmVzb3VyY2VzOiBbcHJpY2luZ0J1aWxkUHJvamVjdC5wcm9qZWN0QXJuXSxcbiAgICB9KSk7XG5cbiAgICAvLyBUcmlnZ2VyIHByaWNpbmcgYnVpbGRcbiAgICBjb25zdCBwcmljaW5nQnVpbGRUcmlnZ2VyID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnUHJpY2luZ0J1aWxkVHJpZ2dlcicsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogYnVpbGRUcmlnZ2VyRm4uZnVuY3Rpb25Bcm4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIFByb2plY3ROYW1lOiBwcmljaW5nQnVpbGRQcm9qZWN0LnByb2plY3ROYW1lLFxuICAgICAgICBUaW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgcHJpY2luZ0J1aWxkVHJpZ2dlci5ub2RlLmFkZERlcGVuZGVuY3koc2NyaXB0c0RlcGxveW1lbnQpO1xuXG4gICAgLy8gV2FpdCBmb3IgcHJpY2luZyBidWlsZFxuICAgIGNvbnN0IHByaWNpbmdCdWlsZFdhaXRlciA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ1ByaWNpbmdCdWlsZFdhaXRlcicsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogYnVpbGRXYWl0ZXJGbi5mdW5jdGlvbkFybixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgQnVpbGRJZDogcHJpY2luZ0J1aWxkVHJpZ2dlci5nZXRBdHRTdHJpbmcoJ0J1aWxkSWQnKSxcbiAgICAgICAgTWF4V2FpdFNlY29uZHM6ICcxMjAwJyxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgcHJpY2luZ0J1aWxkV2FpdGVyLm5vZGUuYWRkRGVwZW5kZW5jeShwcmljaW5nQnVpbGRUcmlnZ2VyKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDbG91ZFdhdGNoIE1DUCBTZXJ2ZXIgLSBDb2RlQnVpbGQgKyBUcmFuc2Zvcm1cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgY2xvdWR3YXRjaEJ1aWxkUHJvamVjdCA9IHRoaXMuY3JlYXRlVHJhbnNmb3JtQnVpbGRQcm9qZWN0KFxuICAgICAgJ0Nsb3VkV2F0Y2hNY3AnLFxuICAgICAgdGhpcy5jbG91ZHdhdGNoTWNwUmVwb3NpdG9yeSxcbiAgICAgICdjb2RlYnVpbGQtc2NyaXB0cy8nLFxuICAgICAgJ2J1aWxkc3BlYy1jbG91ZHdhdGNoLnltbCcsXG4gICAgKTtcbiAgICBjbG91ZHdhdGNoQnVpbGRQcm9qZWN0Lm5vZGUuYWRkRGVwZW5kZW5jeShzY3JpcHRzRGVwbG95bWVudCk7XG5cbiAgICAvLyBHcmFudCBMYW1iZGEgcGVybWlzc2lvbnMgZm9yIENsb3VkV2F0Y2hcbiAgICBidWlsZFRyaWdnZXJGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogWydjb2RlYnVpbGQ6U3RhcnRCdWlsZCddLFxuICAgICAgcmVzb3VyY2VzOiBbY2xvdWR3YXRjaEJ1aWxkUHJvamVjdC5wcm9qZWN0QXJuXSxcbiAgICB9KSk7XG4gICAgYnVpbGRXYWl0ZXJGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogWydjb2RlYnVpbGQ6QmF0Y2hHZXRCdWlsZHMnXSxcbiAgICAgIHJlc291cmNlczogW2Nsb3Vkd2F0Y2hCdWlsZFByb2plY3QucHJvamVjdEFybl0sXG4gICAgfSkpO1xuXG4gICAgLy8gVHJpZ2dlciBDbG91ZFdhdGNoIGJ1aWxkXG4gICAgY29uc3QgY2xvdWR3YXRjaEJ1aWxkVHJpZ2dlciA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ0Nsb3VkV2F0Y2hCdWlsZFRyaWdnZXInLCB7XG4gICAgICBzZXJ2aWNlVG9rZW46IGJ1aWxkVHJpZ2dlckZuLmZ1bmN0aW9uQXJuLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBQcm9qZWN0TmFtZTogY2xvdWR3YXRjaEJ1aWxkUHJvamVjdC5wcm9qZWN0TmFtZSxcbiAgICAgICAgVGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGNsb3Vkd2F0Y2hCdWlsZFRyaWdnZXIubm9kZS5hZGREZXBlbmRlbmN5KHNjcmlwdHNEZXBsb3ltZW50KTtcblxuICAgIC8vIFdhaXQgZm9yIENsb3VkV2F0Y2ggYnVpbGRcbiAgICBjb25zdCBjbG91ZHdhdGNoQnVpbGRXYWl0ZXIgPSBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdDbG91ZFdhdGNoQnVpbGRXYWl0ZXInLCB7XG4gICAgICBzZXJ2aWNlVG9rZW46IGJ1aWxkV2FpdGVyRm4uZnVuY3Rpb25Bcm4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEJ1aWxkSWQ6IGNsb3Vkd2F0Y2hCdWlsZFRyaWdnZXIuZ2V0QXR0U3RyaW5nKCdCdWlsZElkJyksXG4gICAgICAgIE1heFdhaXRTZWNvbmRzOiAnMTIwMCcsXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGNsb3Vkd2F0Y2hCdWlsZFdhaXRlci5ub2RlLmFkZERlcGVuZGVuY3koY2xvdWR3YXRjaEJ1aWxkVHJpZ2dlcik7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ2xvdWRUcmFpbCBNQ1AgU2VydmVyIC0gQ29kZUJ1aWxkICsgVHJhbnNmb3JtXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGNsb3VkdHJhaWxCdWlsZFByb2plY3QgPSB0aGlzLmNyZWF0ZVRyYW5zZm9ybUJ1aWxkUHJvamVjdChcbiAgICAgICdDbG91ZFRyYWlsTWNwJyxcbiAgICAgIHRoaXMuY2xvdWR0cmFpbE1jcFJlcG9zaXRvcnksXG4gICAgICAnY29kZWJ1aWxkLXNjcmlwdHMvJyxcbiAgICAgICdidWlsZHNwZWMtY2xvdWR0cmFpbC55bWwnLFxuICAgICk7XG4gICAgY2xvdWR0cmFpbEJ1aWxkUHJvamVjdC5ub2RlLmFkZERlcGVuZGVuY3koc2NyaXB0c0RlcGxveW1lbnQpO1xuXG4gICAgLy8gR3JhbnQgTGFtYmRhIHBlcm1pc3Npb25zIGZvciBDbG91ZFRyYWlsXG4gICAgYnVpbGRUcmlnZ2VyRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnY29kZWJ1aWxkOlN0YXJ0QnVpbGQnXSxcbiAgICAgIHJlc291cmNlczogW2Nsb3VkdHJhaWxCdWlsZFByb2plY3QucHJvamVjdEFybl0sXG4gICAgfSkpO1xuICAgIGJ1aWxkV2FpdGVyRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnY29kZWJ1aWxkOkJhdGNoR2V0QnVpbGRzJ10sXG4gICAgICByZXNvdXJjZXM6IFtjbG91ZHRyYWlsQnVpbGRQcm9qZWN0LnByb2plY3RBcm5dLFxuICAgIH0pKTtcblxuICAgIC8vIFRyaWdnZXIgQ2xvdWRUcmFpbCBidWlsZFxuICAgIGNvbnN0IGNsb3VkdHJhaWxCdWlsZFRyaWdnZXIgPSBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdDbG91ZFRyYWlsQnVpbGRUcmlnZ2VyJywge1xuICAgICAgc2VydmljZVRva2VuOiBidWlsZFRyaWdnZXJGbi5mdW5jdGlvbkFybixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgUHJvamVjdE5hbWU6IGNsb3VkdHJhaWxCdWlsZFByb2plY3QucHJvamVjdE5hbWUsXG4gICAgICAgIFRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBjbG91ZHRyYWlsQnVpbGRUcmlnZ2VyLm5vZGUuYWRkRGVwZW5kZW5jeShzY3JpcHRzRGVwbG95bWVudCk7XG5cbiAgICAvLyBXYWl0IGZvciBDbG91ZFRyYWlsIGJ1aWxkXG4gICAgY29uc3QgY2xvdWR0cmFpbEJ1aWxkV2FpdGVyID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnQ2xvdWRUcmFpbEJ1aWxkV2FpdGVyJywge1xuICAgICAgc2VydmljZVRva2VuOiBidWlsZFdhaXRlckZuLmZ1bmN0aW9uQXJuLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBCdWlsZElkOiBjbG91ZHRyYWlsQnVpbGRUcmlnZ2VyLmdldEF0dFN0cmluZygnQnVpbGRJZCcpLFxuICAgICAgICBNYXhXYWl0U2Vjb25kczogJzEyMDAnLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBjbG91ZHRyYWlsQnVpbGRXYWl0ZXIubm9kZS5hZGREZXBlbmRlbmN5KGNsb3VkdHJhaWxCdWlsZFRyaWdnZXIpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEludmVudG9yeSBNQ1AgU2VydmVyIC0gRGlyZWN0IERvY2tlciBCdWlsZFxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBpbnZlbnRvcnlCdWlsZFJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ0ludmVudG9yeU1jcENvZGVCdWlsZFJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnY29kZWJ1aWxkLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnSUFNIHJvbGUgZm9yIENvZGVCdWlsZCB0byBidWlsZCBJbnZlbnRvcnkgTUNQIGNvbnRhaW5lciBpbWFnZScsXG4gICAgICBpbmxpbmVQb2xpY2llczoge1xuICAgICAgICBDbG91ZFdhdGNoTG9nc1BvbGljeTogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW25ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgIGFjdGlvbnM6IFsnbG9nczpDcmVhdGVMb2dHcm91cCcsICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsICdsb2dzOlB1dExvZ0V2ZW50cyddLFxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6bG9nczoke2Nkay5Bd3MuUkVHSU9OfToke2Nkay5Bd3MuQUNDT1VOVF9JRH06bG9nLWdyb3VwOi9hd3MvY29kZWJ1aWxkLypgXSxcbiAgICAgICAgICB9KV0sXG4gICAgICAgIH0pLFxuICAgICAgICBFQ1JQdXNoUG9saWN5OiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdlY3I6QmF0Y2hDaGVja0xheWVyQXZhaWxhYmlsaXR5JywgJ2VjcjpHZXREb3dubG9hZFVybEZvckxheWVyJywgJ2VjcjpCYXRjaEdldEltYWdlJyxcbiAgICAgICAgICAgICAgICAnZWNyOlB1dEltYWdlJywgJ2VjcjpJbml0aWF0ZUxheWVyVXBsb2FkJywgJ2VjcjpVcGxvYWRMYXllclBhcnQnLCAnZWNyOkNvbXBsZXRlTGF5ZXJVcGxvYWQnLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFt0aGlzLmludmVudG9yeU1jcFJlcG9zaXRvcnkucmVwb3NpdG9yeUFybl0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbJ2VjcjpHZXRBdXRob3JpemF0aW9uVG9rZW4nXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pLFxuICAgICAgICBTM1JlYWRQb2xpY3k6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICBhY3Rpb25zOiBbJ3MzOkdldE9iamVjdCcsICdzMzpHZXRPYmplY3RWZXJzaW9uJ10sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFt0aGlzLnNvdXJjZUJ1Y2tldC5hcm5Gb3JPYmplY3RzKCcqJyldLFxuICAgICAgICAgIH0pXSxcbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgaW52ZW50b3J5QnVpbGRQcm9qZWN0ID0gbmV3IGNvZGVidWlsZC5Qcm9qZWN0KHRoaXMsICdJbnZlbnRvcnlNY3BCdWlsZFByb2plY3QnLCB7XG4gICAgICBwcm9qZWN0TmFtZTogJ2Nsb3Vkb3BzLWludmVudG9yeW1jcC1idWlsZCcsXG4gICAgICBkZXNjcmlwdGlvbjogJ0J1aWxkIEFSTTY0IGNvbnRhaW5lciBmb3IgSW52ZW50b3J5IE1DUCBzZXJ2ZXInLFxuICAgICAgc291cmNlOiBjb2RlYnVpbGQuU291cmNlLnMzKHtcbiAgICAgICAgYnVja2V0OiB0aGlzLnNvdXJjZUJ1Y2tldCxcbiAgICAgICAgcGF0aDogJ2ludmVudG9yeS8nLFxuICAgICAgfSksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBidWlsZEltYWdlOiBjb2RlYnVpbGQuTGludXhBcm1CdWlsZEltYWdlLkFNQVpPTl9MSU5VWF8yX1NUQU5EQVJEXzNfMCxcbiAgICAgICAgY29tcHV0ZVR5cGU6IGNvZGVidWlsZC5Db21wdXRlVHlwZS5TTUFMTCxcbiAgICAgICAgcHJpdmlsZWdlZDogdHJ1ZSxcbiAgICAgICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcbiAgICAgICAgICBBV1NfREVGQVVMVF9SRUdJT046IHsgdmFsdWU6IGNkay5Bd3MuUkVHSU9OIH0sXG4gICAgICAgICAgQVdTX0FDQ09VTlRfSUQ6IHsgdmFsdWU6IGNkay5Bd3MuQUNDT1VOVF9JRCB9LFxuICAgICAgICAgIEVDUl9SRVBPX1VSSTogeyB2YWx1ZTogdGhpcy5pbnZlbnRvcnlNY3BSZXBvc2l0b3J5LnJlcG9zaXRvcnlVcmkgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICBidWlsZFNwZWM6IGNvZGVidWlsZC5CdWlsZFNwZWMuZnJvbU9iamVjdCh7XG4gICAgICAgIHZlcnNpb246ICcwLjInLFxuICAgICAgICBwaGFzZXM6IHtcbiAgICAgICAgICBwcmVfYnVpbGQ6IHtcbiAgICAgICAgICAgIGNvbW1hbmRzOiBbXG4gICAgICAgICAgICAgICdlY2hvIFwiPT09IFBoYXNlIFByZS1idWlsZCAtIEVDUiBMb2dpbiA9PT1cIicsXG4gICAgICAgICAgICAgICdhd3MgZWNyIGdldC1sb2dpbi1wYXNzd29yZCAtLXJlZ2lvbiAkQVdTX0RFRkFVTFRfUkVHSU9OIHwgZG9ja2VyIGxvZ2luIC0tdXNlcm5hbWUgQVdTIC0tcGFzc3dvcmQtc3RkaW4gJEFXU19BQ0NPVU5UX0lELmRrci5lY3IuJEFXU19ERUZBVUxUX1JFR0lPTi5hbWF6b25hd3MuY29tJyxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICBidWlsZDoge1xuICAgICAgICAgICAgY29tbWFuZHM6IFtcbiAgICAgICAgICAgICAgJ2VjaG8gXCI9PT0gUGhhc2UgQnVpbGQgLSBEb2NrZXIgaW1hZ2UgPT09XCInLFxuICAgICAgICAgICAgICAnZG9ja2VyIGJ1aWxkIC10ICRFQ1JfUkVQT19VUkk6JENPREVCVUlMRF9CVUlMRF9OVU1CRVIgLicsXG4gICAgICAgICAgICAgICdkb2NrZXIgdGFnICRFQ1JfUkVQT19VUkk6JENPREVCVUlMRF9CVUlMRF9OVU1CRVIgJEVDUl9SRVBPX1VSSTpsYXRlc3QnLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHBvc3RfYnVpbGQ6IHtcbiAgICAgICAgICAgIGNvbW1hbmRzOiBbXG4gICAgICAgICAgICAgICdlY2hvIFwiPT09IFBoYXNlIFBvc3QtYnVpbGQgLSBQdXNoIHRvIEVDUiA9PT1cIicsXG4gICAgICAgICAgICAgICdkb2NrZXIgcHVzaCAkRUNSX1JFUE9fVVJJOiRDT0RFQlVJTERfQlVJTERfTlVNQkVSJyxcbiAgICAgICAgICAgICAgJ2RvY2tlciBwdXNoICRFQ1JfUkVQT19VUkk6bGF0ZXN0JyxcbiAgICAgICAgICAgICAgJ2VjaG8gXCJJbnZlbnRvcnkgTUNQIGltYWdlIHB1c2hlZCBzdWNjZXNzZnVsbHkuXCInLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICByb2xlOiBpbnZlbnRvcnlCdWlsZFJvbGUsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygzMCksXG4gICAgfSk7XG4gICAgaW52ZW50b3J5QnVpbGRQcm9qZWN0Lm5vZGUuYWRkRGVwZW5kZW5jeShpbnZlbnRvcnlTb3VyY2VEZXBsb3ltZW50KTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhpbnZlbnRvcnlCdWlsZFJvbGUsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsIHJlYXNvbjogJ1dpbGRjYXJkIGZvciBlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuLCBTMywgQ2xvdWRXYXRjaCBMb2dzLicgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhpbnZlbnRvcnlCdWlsZFByb2plY3QsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtQ0I0JywgcmVhc29uOiAnS01TIGVuY3J5cHRpb24gbm90IGVuYWJsZWQgZm9yIGRldi9kZW1vLicgfSxcbiAgICBdKTtcblxuICAgIC8vIEdyYW50IExhbWJkYSBwZXJtaXNzaW9ucyBmb3IgSW52ZW50b3J5XG4gICAgYnVpbGRUcmlnZ2VyRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnY29kZWJ1aWxkOlN0YXJ0QnVpbGQnXSxcbiAgICAgIHJlc291cmNlczogW2ludmVudG9yeUJ1aWxkUHJvamVjdC5wcm9qZWN0QXJuXSxcbiAgICB9KSk7XG4gICAgYnVpbGRXYWl0ZXJGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogWydjb2RlYnVpbGQ6QmF0Y2hHZXRCdWlsZHMnXSxcbiAgICAgIHJlc291cmNlczogW2ludmVudG9yeUJ1aWxkUHJvamVjdC5wcm9qZWN0QXJuXSxcbiAgICB9KSk7XG5cbiAgICAvLyBUcmlnZ2VyIEludmVudG9yeSBidWlsZFxuICAgIGNvbnN0IGludmVudG9yeUJ1aWxkVHJpZ2dlciA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ0ludmVudG9yeUJ1aWxkVHJpZ2dlcicsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogYnVpbGRUcmlnZ2VyRm4uZnVuY3Rpb25Bcm4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIFByb2plY3ROYW1lOiBpbnZlbnRvcnlCdWlsZFByb2plY3QucHJvamVjdE5hbWUsXG4gICAgICAgIFRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBpbnZlbnRvcnlCdWlsZFRyaWdnZXIubm9kZS5hZGREZXBlbmRlbmN5KGludmVudG9yeVNvdXJjZURlcGxveW1lbnQpO1xuXG4gICAgLy8gV2FpdCBmb3IgSW52ZW50b3J5IGJ1aWxkXG4gICAgY29uc3QgaW52ZW50b3J5QnVpbGRXYWl0ZXIgPSBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdJbnZlbnRvcnlCdWlsZFdhaXRlcicsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogYnVpbGRXYWl0ZXJGbi5mdW5jdGlvbkFybixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgQnVpbGRJZDogaW52ZW50b3J5QnVpbGRUcmlnZ2VyLmdldEF0dFN0cmluZygnQnVpbGRJZCcpLFxuICAgICAgICBNYXhXYWl0U2Vjb25kczogJzEyMDAnLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBpbnZlbnRvcnlCdWlsZFdhaXRlci5ub2RlLmFkZERlcGVuZGVuY3koaW52ZW50b3J5QnVpbGRUcmlnZ2VyKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBNYWluIEFnZW50IFJ1bnRpbWUgLSBTdGFuZGFyZCBEb2NrZXIgQnVpbGRcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy5idWlsZE1haW5SdW50aW1lSW1hZ2UoYWdlbnRjb3JlRGVwbG95bWVudCk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTWFpblJlcG9zaXRvcnlVcmknLCB7XG4gICAgICB2YWx1ZTogdGhpcy5yZXBvc2l0b3J5LnJlcG9zaXRvcnlVcmksXG4gICAgICBkZXNjcmlwdGlvbjogJ01haW4gUnVudGltZSBFQ1IgUmVwb3NpdG9yeSBVUkknLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LU1haW5SZXBvc2l0b3J5VXJpYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdCaWxsaW5nTWNwUmVwb3NpdG9yeVVyaScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmJpbGxpbmdNY3BSZXBvc2l0b3J5LnJlcG9zaXRvcnlVcmksXG4gICAgICBkZXNjcmlwdGlvbjogJ0JpbGxpbmcgTUNQIFJ1bnRpbWUgRUNSIFJlcG9zaXRvcnkgVVJJJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1CaWxsaW5nTWNwUmVwb3NpdG9yeVVyaWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnUHJpY2luZ01jcFJlcG9zaXRvcnlVcmknLCB7XG4gICAgICB2YWx1ZTogdGhpcy5wcmljaW5nTWNwUmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpLFxuICAgICAgZGVzY3JpcHRpb246ICdQcmljaW5nIE1DUCBSdW50aW1lIEVDUiBSZXBvc2l0b3J5IFVSSScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tUHJpY2luZ01jcFJlcG9zaXRvcnlVcmlgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Nsb3VkV2F0Y2hNY3BSZXBvc2l0b3J5VXJpJywge1xuICAgICAgdmFsdWU6IHRoaXMuY2xvdWR3YXRjaE1jcFJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ2xvdWRXYXRjaCBNQ1AgUnVudGltZSBFQ1IgUmVwb3NpdG9yeSBVUkknLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUNsb3VkV2F0Y2hNY3BSZXBvc2l0b3J5VXJpYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDbG91ZFRyYWlsTWNwUmVwb3NpdG9yeVVyaScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmNsb3VkdHJhaWxNY3BSZXBvc2l0b3J5LnJlcG9zaXRvcnlVcmksXG4gICAgICBkZXNjcmlwdGlvbjogJ0Nsb3VkVHJhaWwgTUNQIFJ1bnRpbWUgRUNSIFJlcG9zaXRvcnkgVVJJJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1DbG91ZFRyYWlsTWNwUmVwb3NpdG9yeVVyaWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnSW52ZW50b3J5TWNwUmVwb3NpdG9yeVVyaScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmludmVudG9yeU1jcFJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnSW52ZW50b3J5IE1DUCBSdW50aW1lIEVDUiBSZXBvc2l0b3J5IFVSSScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tSW52ZW50b3J5TWNwUmVwb3NpdG9yeVVyaWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnU291cmNlQnVja2V0TmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnNvdXJjZUJ1Y2tldC5idWNrZXROYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdTMyBidWNrZXQgZm9yIENvZGVCdWlsZCBzb3VyY2Ugc2NyaXB0cycsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ0RLLU5hZyBTdXBwcmVzc2lvbnNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKGFjY2Vzc0xvZ3NCdWNrZXQsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtUzEnLCByZWFzb246ICdUZXJtaW5hbCBhY2Nlc3MtbG9nIGJ1Y2tldDsgaXQgbG9ncyB0byBpdHNlbGYgKHNlcnZlckFjY2Vzc0xvZ3NQcmVmaXggc2V0KSwgc28gYWNjZXNzIGxvZ2dpbmcgaXMgZW5hYmxlZC4nIH0sXG4gICAgXSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkU3RhY2tTdXBwcmVzc2lvbnModGhpcywgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1MMScsIHJlYXNvbjogJ0xhbWJkYSBydW50aW1lIHZlcnNpb24gbWFuYWdlZCBieSBDREsuJyB9LFxuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1JQU00JywgcmVhc29uOiAnQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlIGlzIEFXUyBiZXN0IHByYWN0aWNlLicgfSxcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsIHJlYXNvbjogJ1dpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBTMywgRUNSLCBDbG91ZFdhdGNoLCBDb2RlQnVpbGQuJyB9LFxuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1DQjQnLCByZWFzb246ICdLTVMgZW5jcnlwdGlvbiBub3QgZW5hYmxlZCBmb3IgZGV2L2RlbW8uJyB9LFxuICAgIF0pO1xuICB9XG5cbiAgLyoqXG4gICAqIENyZWF0ZSBhIENvZGVCdWlsZCBwcm9qZWN0IHRoYXQgY2xvbmVzIHVwc3RyZWFtIE1DUCByZXBvLFxuICAgKiBhcHBsaWVzIHBhdGNoIHNjcmlwdHMsIGJ1aWxkcyBBUk02NCBEb2NrZXIgaW1hZ2UsXG4gICAqIGFuZCBwdXNoZXMgdG8gRUNSLlxuICAgKi9cbiAgcHJpdmF0ZSBjcmVhdGVUcmFuc2Zvcm1CdWlsZFByb2plY3QoXG4gICAgaWQ6IHN0cmluZyxcbiAgICByZXBvc2l0b3J5OiBlY3IuUmVwb3NpdG9yeSxcbiAgICBzb3VyY2VQYXRoOiBzdHJpbmcsXG4gICAgYnVpbGRzcGVjRmlsZTogc3RyaW5nLFxuICApOiBjb2RlYnVpbGQuUHJvamVjdCB7XG4gICAgY29uc3QgY29kZUJ1aWxkUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCBgJHtpZH1Db2RlQnVpbGRSb2xlYCwge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2NvZGVidWlsZC5hbWF6b25hd3MuY29tJyksXG4gICAgICBkZXNjcmlwdGlvbjogYElBTSByb2xlIGZvciBDb2RlQnVpbGQgdG8gYnVpbGQgJHtpZH0gY29udGFpbmVyIGltYWdlYCxcbiAgICAgIGlubGluZVBvbGljaWVzOiB7XG4gICAgICAgIENsb3VkV2F0Y2hMb2dzUG9saWN5OiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgYWN0aW9uczogWydsb2dzOkNyZWF0ZUxvZ0dyb3VwJywgJ2xvZ3M6Q3JlYXRlTG9nU3RyZWFtJywgJ2xvZ3M6UHV0TG9nRXZlbnRzJ10sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpsb2dzOiR7Y2RrLkF3cy5SRUdJT059OiR7Y2RrLkF3cy5BQ0NPVU5UX0lEfTpsb2ctZ3JvdXA6L2F3cy9jb2RlYnVpbGQvKmBdLFxuICAgICAgICAgIH0pXSxcbiAgICAgICAgfSksXG4gICAgICAgIEVDUlB1c2hQb2xpY3k6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ2VjcjpCYXRjaENoZWNrTGF5ZXJBdmFpbGFiaWxpdHknLCAnZWNyOkdldERvd25sb2FkVXJsRm9yTGF5ZXInLCAnZWNyOkJhdGNoR2V0SW1hZ2UnLFxuICAgICAgICAgICAgICAgICdlY3I6UHV0SW1hZ2UnLCAnZWNyOkluaXRpYXRlTGF5ZXJVcGxvYWQnLCAnZWNyOlVwbG9hZExheWVyUGFydCcsICdlY3I6Q29tcGxldGVMYXllclVwbG9hZCcsXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHJlc291cmNlczogW3JlcG9zaXRvcnkucmVwb3NpdG9yeUFybl0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbJ2VjcjpHZXRBdXRob3JpemF0aW9uVG9rZW4nXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0pLFxuICAgICAgICBTM1JlYWRQb2xpY3k6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICBhY3Rpb25zOiBbJ3MzOkdldE9iamVjdCcsICdzMzpHZXRPYmplY3RWZXJzaW9uJ10sXG4gICAgICAgICAgICByZXNvdXJjZXM6IFt0aGlzLnNvdXJjZUJ1Y2tldC5hcm5Gb3JPYmplY3RzKCcqJyldLFxuICAgICAgICAgIH0pXSxcbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgcHJvamVjdCA9IG5ldyBjb2RlYnVpbGQuUHJvamVjdCh0aGlzLCBgJHtpZH1CdWlsZFByb2plY3RgLCB7XG4gICAgICBwcm9qZWN0TmFtZTogYGNsb3Vkb3BzLSR7aWQudG9Mb3dlckNhc2UoKX0tYnVpbGRgLFxuICAgICAgZGVzY3JpcHRpb246IGBCdWlsZCBBUk02NCBjb250YWluZXIgZm9yICR7aWR9IHdpdGggc3RyZWFtYWJsZS1odHRwIHRyYW5zcG9ydGAsXG4gICAgICBzb3VyY2U6IGNvZGVidWlsZC5Tb3VyY2UuczMoe1xuICAgICAgICBidWNrZXQ6IHRoaXMuc291cmNlQnVja2V0LFxuICAgICAgICBwYXRoOiBzb3VyY2VQYXRoLFxuICAgICAgfSksXG4gICAgICBidWlsZFNwZWM6IGNvZGVidWlsZC5CdWlsZFNwZWMuZnJvbVNvdXJjZUZpbGVuYW1lKGJ1aWxkc3BlY0ZpbGUpLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgYnVpbGRJbWFnZTogY29kZWJ1aWxkLkxpbnV4QXJtQnVpbGRJbWFnZS5BTUFaT05fTElOVVhfMl9TVEFOREFSRF8zXzAsXG4gICAgICAgIGNvbXB1dGVUeXBlOiBjb2RlYnVpbGQuQ29tcHV0ZVR5cGUuU01BTEwsXG4gICAgICAgIHByaXZpbGVnZWQ6IHRydWUsXG4gICAgICAgIGVudmlyb25tZW50VmFyaWFibGVzOiB7XG4gICAgICAgICAgQVdTX0RFRkFVTFRfUkVHSU9OOiB7IHZhbHVlOiBjZGsuQXdzLlJFR0lPTiB9LFxuICAgICAgICAgIEFXU19BQ0NPVU5UX0lEOiB7IHZhbHVlOiBjZGsuQXdzLkFDQ09VTlRfSUQgfSxcbiAgICAgICAgICBFQ1JfUkVQT19VUkk6IHsgdmFsdWU6IHJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaSB9LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHJvbGU6IGNvZGVCdWlsZFJvbGUsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygzMCksXG4gICAgfSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMoY29kZUJ1aWxkUm9sZSwgW1xuICAgICAgeyBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JywgcmVhc29uOiAnV2lsZGNhcmQgZm9yIGVjcjpHZXRBdXRob3JpemF0aW9uVG9rZW4sIFMzLCBDbG91ZFdhdGNoIExvZ3MuJyB9LFxuICAgIF0sIHRydWUpO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKHByb2plY3QsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtQ0I0JywgcmVhc29uOiAnS01TIGVuY3J5cHRpb24gbm90IGVuYWJsZWQgZm9yIGRldi9kZW1vLicgfSxcbiAgICBdKTtcblxuICAgIHJldHVybiBwcm9qZWN0O1xuICB9XG5cbiAgLyoqXG4gICAqIEJ1aWxkIHRoZSBtYWluIGFnZW50IHJ1bnRpbWUgaW1hZ2UgdXNpbmcgc3RhbmRhcmQgRG9ja2VyIGJ1aWxkXG4gICAqIChubyBwYXRjaGluZyBuZWVkZWQgLSBpdCdzIG91ciBvd24gY29kZSkuXG4gICAqL1xuICBwcml2YXRlIGJ1aWxkTWFpblJ1bnRpbWVJbWFnZShzb3VyY2VEZXBsb3ltZW50OiBzM2RlcGxveS5CdWNrZXREZXBsb3ltZW50KTogdm9pZCB7XG4gICAgY29uc3QgYnVpbGRQcm9qZWN0ID0gbmV3IGNvZGVidWlsZC5Qcm9qZWN0KHRoaXMsICdNYWluUnVudGltZUJ1aWxkUHJvamVjdCcsIHtcbiAgICAgIHByb2plY3ROYW1lOiAnY2xvdWRvcHMtbWFpbnJ1bnRpbWUtYnVpbGQnLFxuICAgICAgc291cmNlOiBjb2RlYnVpbGQuU291cmNlLnMzKHtcbiAgICAgICAgYnVja2V0OiB0aGlzLnNvdXJjZUJ1Y2tldCxcbiAgICAgICAgcGF0aDogJ2FnZW50Y29yZS8nLFxuICAgICAgfSksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBidWlsZEltYWdlOiBjb2RlYnVpbGQuTGludXhCdWlsZEltYWdlLkFNQVpPTl9MSU5VWF8yX0FSTV8zLFxuICAgICAgICBwcml2aWxlZ2VkOiB0cnVlLFxuICAgICAgICBjb21wdXRlVHlwZTogY29kZWJ1aWxkLkNvbXB1dGVUeXBlLlNNQUxMLFxuICAgICAgfSxcbiAgICAgIGVudmlyb25tZW50VmFyaWFibGVzOiB7XG4gICAgICAgIEFXU19ERUZBVUxUX1JFR0lPTjogeyB2YWx1ZTogdGhpcy5yZWdpb24gfSxcbiAgICAgICAgQVdTX0FDQ09VTlRfSUQ6IHsgdmFsdWU6IHRoaXMuYWNjb3VudCB9LFxuICAgICAgICBJTUFHRV9SRVBPX05BTUU6IHsgdmFsdWU6IHRoaXMucmVwb3NpdG9yeS5yZXBvc2l0b3J5TmFtZSB9LFxuICAgICAgICBJTUFHRV9UQUc6IHsgdmFsdWU6ICdsYXRlc3QnIH0sXG4gICAgICB9LFxuICAgICAgYnVpbGRTcGVjOiBjb2RlYnVpbGQuQnVpbGRTcGVjLmZyb21PYmplY3Qoe1xuICAgICAgICB2ZXJzaW9uOiAnMC4yJyxcbiAgICAgICAgcGhhc2VzOiB7XG4gICAgICAgICAgcHJlX2J1aWxkOiB7XG4gICAgICAgICAgICBjb21tYW5kczogW1xuICAgICAgICAgICAgICAnZWNobyBMb2dnaW5nIGluIHRvIEFtYXpvbiBFQ1IuLi4nLFxuICAgICAgICAgICAgICAnYXdzIGVjciBnZXQtbG9naW4tcGFzc3dvcmQgLS1yZWdpb24gJEFXU19ERUZBVUxUX1JFR0lPTiB8IGRvY2tlciBsb2dpbiAtLXVzZXJuYW1lIEFXUyAtLXBhc3N3b3JkLXN0ZGluICRBV1NfQUNDT1VOVF9JRC5ka3IuZWNyLiRBV1NfREVGQVVMVF9SRUdJT04uYW1hem9uYXdzLmNvbScsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgYnVpbGQ6IHtcbiAgICAgICAgICAgIGNvbW1hbmRzOiBbXG4gICAgICAgICAgICAgICdlY2hvIEJ1aWxkaW5nIHRoZSBEb2NrZXIgaW1hZ2UuLi4nLFxuICAgICAgICAgICAgICAnZG9ja2VyIGJ1aWxkIC10ICRJTUFHRV9SRVBPX05BTUU6JElNQUdFX1RBRyAuJyxcbiAgICAgICAgICAgICAgJ2RvY2tlciB0YWcgJElNQUdFX1JFUE9fTkFNRTokSU1BR0VfVEFHICRBV1NfQUNDT1VOVF9JRC5ka3IuZWNyLiRBV1NfREVGQVVMVF9SRUdJT04uYW1hem9uYXdzLmNvbS8kSU1BR0VfUkVQT19OQU1FOiRJTUFHRV9UQUcnLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHBvc3RfYnVpbGQ6IHtcbiAgICAgICAgICAgIGNvbW1hbmRzOiBbXG4gICAgICAgICAgICAgICdlY2hvIFB1c2hpbmcgdGhlIERvY2tlciBpbWFnZS4uLicsXG4gICAgICAgICAgICAgICdkb2NrZXIgcHVzaCAkQVdTX0FDQ09VTlRfSUQuZGtyLmVjci4kQVdTX0RFRkFVTFRfUkVHSU9OLmFtYXpvbmF3cy5jb20vJElNQUdFX1JFUE9fTkFNRTokSU1BR0VfVEFHJyxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgdGhpcy5yZXBvc2l0b3J5LmdyYW50UHVsbFB1c2goYnVpbGRQcm9qZWN0KTtcbiAgICB0aGlzLnNvdXJjZUJ1Y2tldC5ncmFudFJlYWQoYnVpbGRQcm9qZWN0KTtcbiAgICBidWlsZFByb2plY3QuYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbiddLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICB9KSk7XG5cbiAgICBjb25zdCB0cmlnZ2VyRm4gPSBuZXcgY2RrLmF3c19sYW1iZGEuRnVuY3Rpb24odGhpcywgJ01haW5SdW50aW1lQnVpbGRUcmlnZ2VyRm4nLCB7XG4gICAgICBydW50aW1lOiBjZGsuYXdzX2xhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzE0LFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgY29kZTogY2RrLmF3c19sYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uLy4uL2xhbWJkYS9idWlsZC10cmlnZ2VyJykpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMSksXG4gICAgfSk7XG4gICAgdHJpZ2dlckZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2NvZGVidWlsZDpTdGFydEJ1aWxkJ10sXG4gICAgICByZXNvdXJjZXM6IFtidWlsZFByb2plY3QucHJvamVjdEFybl0sXG4gICAgfSkpO1xuICAgIHRyaWdnZXJGbi5ub2RlLmFkZERlcGVuZGVuY3koc291cmNlRGVwbG95bWVudCk7XG5cbiAgICBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdNYWluUnVudGltZVRyaWdnZXJCdWlsZCcsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogdHJpZ2dlckZuLmZ1bmN0aW9uQXJuLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBQcm9qZWN0TmFtZTogYnVpbGRQcm9qZWN0LnByb2plY3ROYW1lLFxuICAgICAgICBUaW1lc3RhbXA6IGAke0RhdGUubm93KCl9LSR7Y3J5cHRvLnJhbmRvbUJ5dGVzKDgpLnRvU3RyaW5nKCdoZXgnKX1gLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhidWlsZFByb2plY3QsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtQ0I0JywgcmVhc29uOiAnS01TIGVuY3J5cHRpb24gbm90IGVuYWJsZWQgZm9yIGRldi9kZW1vLicgfSxcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsIHJlYXNvbjogJ1dpbGRjYXJkIGZvciBFQ1IsIFMzLCBDbG91ZFdhdGNoLicgfSxcbiAgICBdLCB0cnVlKTtcbiAgfVxufVxuIl19