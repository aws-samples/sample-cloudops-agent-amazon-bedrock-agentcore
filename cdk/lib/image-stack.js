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
exports.ImageStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const ecr = __importStar(require("aws-cdk-lib/aws-ecr"));
const codebuild = __importStar(require("aws-cdk-lib/aws-codebuild"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const s3deploy = __importStar(require("aws-cdk-lib/aws-s3-deployment"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const path = __importStar(require("path"));
const cdk_nag_1 = require("cdk-nag");
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
            sources: [s3deploy.Source.asset(path.join(__dirname, '../../codebuild-scripts'))],
            destinationBucket: this.sourceBucket,
            destinationKeyPrefix: 'codebuild-scripts/',
            extract: true,
            prune: false,
            retainOnDelete: false,
            memoryLimit: 512,
        });
        // Also upload agentcore directory for main runtime build
        const agentcoreDeployment = new s3deploy.BucketDeployment(this, 'AgentcoreSourceDeployment', {
            sources: [s3deploy.Source.asset(path.join(__dirname, '../../agentcore'))],
            destinationBucket: this.sourceBucket,
            destinationKeyPrefix: 'agentcore/',
        });
        // Upload inventory MCP server source to S3
        const inventorySourceDeployment = new s3deploy.BucketDeployment(this, 'InventorySourceDeployment', {
            sources: [s3deploy.Source.asset(path.join(__dirname, '../../mcp-servers/inventory'))],
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
                Timestamp: `${Date.now()}-${Math.random().toString(36).substring(7)}`,
            },
        });
        cdk_nag_1.NagSuppressions.addResourceSuppressions(buildProject, [
            { id: 'AwsSolutions-CB4', reason: 'KMS encryption not enabled for dev/demo.' },
            { id: 'AwsSolutions-IAM5', reason: 'Wildcard for ECR, S3, CloudWatch.' },
        ], true);
    }
}
exports.ImageStack = ImageStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW1hZ2Utc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbWFnZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMseURBQTJDO0FBQzNDLHFFQUF1RDtBQUN2RCx5REFBMkM7QUFDM0MsdURBQXlDO0FBQ3pDLHdFQUEwRDtBQUMxRCwrREFBaUQ7QUFFakQsMkNBQTZCO0FBQzdCLHFDQUEwQztBQUUxQzs7Ozs7Ozs7Ozs7O0dBWUc7QUFDSCxNQUFhLFVBQVcsU0FBUSxHQUFHLENBQUMsS0FBSztJQVN2QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQzlELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDhDQUE4QztRQUM5QyxJQUFJLENBQUMsVUFBVSxHQUFHLElBQUksR0FBRyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLEVBQUU7WUFDOUQsY0FBYyxFQUFFLHdCQUF3QjtZQUN4QyxhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLGFBQWEsRUFBRSxJQUFJO1lBQ25CLGVBQWUsRUFBRSxJQUFJO1lBQ3JCLGNBQWMsRUFBRSxDQUFDLEVBQUUsV0FBVyxFQUFFLHFCQUFxQixFQUFFLGFBQWEsRUFBRSxFQUFFLEVBQUUsQ0FBQztTQUM1RSxDQUFDLENBQUM7UUFFSCxnREFBZ0Q7UUFDaEQsSUFBSSxDQUFDLG9CQUFvQixHQUFHLElBQUksR0FBRyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsc0JBQXNCLEVBQUU7WUFDM0UsY0FBYyxFQUFFLDhCQUE4QjtZQUM5QyxhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLGFBQWEsRUFBRSxJQUFJO1lBQ25CLGVBQWUsRUFBRSxJQUFJO1lBQ3JCLGNBQWMsRUFBRSxDQUFDLEVB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QUFDO1FBRUgseUJBQWUsQ0FBQyx1QkFBdUIsQ0FBQyxZQUFZLEVBQUU7WUFDcEQsRUFBRSxFQUFFLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxFQUFFLDBDQUEwQyxFQUFFO1lBQzlFLEVBQUUsRUFBRSxFQUFFLG1CQUFtQixFQUFFLE1BQU0sRUFBRSxtQ0FBbUMsRUFBRTtTQUN6RSxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQ1gsQ0FBQztDQUNGO0FBbHFCRCxnQ0FrcUJDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGVjciBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNyJztcbmltcG9ydCAqIGFzIGNvZGVidWlsZCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY29kZWJ1aWxkJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIHMzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMyc7XG5pbXBvcnQgKiBhcyBzM2RlcGxveSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMtZGVwbG95bWVudCc7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBOYWdTdXBwcmVzc2lvbnMgfSBmcm9tICdjZGstbmFnJztcblxuLyoqXG4gKiBJbWFnZVN0YWNrOiBCdWlsZHMgRG9ja2VyIGltYWdlcyBmb3IgTUNQIHNlcnZlciBydW50aW1lcyB1c2luZyB0aGVcbiAqIHN0ZGlvLXRvLUhUVFAgcGF0Y2hpbmcgcGF0dGVybi5cbiAqXG4gKiBGb3IgZWFjaCBNQ1Agc2VydmVyIChiaWxsaW5nLCBwcmljaW5nKTpcbiAqICAgMS4gQ29kZUJ1aWxkIGNsb25lcyB0aGUgdXBzdHJlYW0gQVdTIExhYnMgTUNQIHJlcG9cbiAqICAgMi4gcGF0Y2gte3NlcnZlcn0uc2ggcGF0Y2hlcyBzZXJ2ZXIucHkgZm9yIHN0cmVhbWFibGUtaHR0cCB0cmFuc3BvcnRcbiAqICAgMy4gQWRkcyB1dmljb3JuICsgc3RhcmxldHRlIGRlcGVuZGVuY2llc1xuICogICA0LiBQYXRjaGVzIERvY2tlcmZpbGUgKEVYUE9TRSA4MDAwLCBlbnRyeXBvaW50LCBoZWFsdGhjaGVjaylcbiAqICAgNS4gQnVpbGRzIEFSTTY0IERvY2tlciBpbWFnZSBhbmQgcHVzaGVzIHRvIEVDUlxuICpcbiAqIEJhc2VkIG9uOiBodHRwczovL2dpdGh1Yi5jb20vYXdzLXNhbXBsZXMvc2FtcGxlLWF3cy1zdGRpby1odHRwLXByb3h5LW1jcFxuICovXG5leHBvcnQgY2xhc3MgSW1hZ2VTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSByZXBvc2l0b3J5OiBlY3IuUmVwb3NpdG9yeTtcbiAgcHVibGljIHJlYWRvbmx5IGJpbGxpbmdNY3BSZXBvc2l0b3J5OiBlY3IuUmVwb3NpdG9yeTtcbiAgcHVibGljIHJlYWRvbmx5IHByaWNpbmdNY3BSZXBvc2l0b3J5OiBlY3IuUmVwb3NpdG9yeTtcbiAgcHVibGljIHJlYWRvbmx5IGNsb3Vkd2F0Y2hNY3BSZXBvc2l0b3J5OiBlY3IuUmVwb3NpdG9yeTtcbiAgcHVibGljIHJlYWRvbmx5IGNsb3VkdHJhaWxNY3BSZXBvc2l0b3J5OiBlY3IuUmVwb3NpdG9yeTtcbiAgcHVibGljIHJlYWRvbmx5IGludmVudG9yeU1jcFJlcG9zaXRvcnk6IGVjci5SZXBvc2l0b3J5O1xuICBwdWJsaWMgcmVhZG9ubHkgc291cmNlQnVja2V0OiBzMy5CdWNrZXQ7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gRUNSIFJlcG9zaXRvcnkgZm9yIE1haW4gQWdlbnQgUnVudGltZSBpbWFnZVxuICAgIHRoaXMucmVwb3NpdG9yeSA9IG5ldyBlY3IuUmVwb3NpdG9yeSh0aGlzLCAnUnVudGltZVJlcG9zaXRvcnknLCB7XG4gICAgICByZXBvc2l0b3J5TmFtZTogJ2Nsb3Vkb3BzLWFnZW50LXJ1bnRpbWUnLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGVtcHR5T25EZWxldGU6IHRydWUsXG4gICAgICBpbWFnZVNjYW5PblB1c2g6IHRydWUsXG4gICAgICBsaWZlY3ljbGVSdWxlczogW3sgZGVzY3JpcHRpb246ICdLZWVwIGxhc3QgMTAgaW1hZ2VzJywgbWF4SW1hZ2VDb3VudDogMTAgfV0sXG4gICAgfSk7XG5cbiAgICAvLyBFQ1IgUmVwb3NpdG9yeSBmb3IgQmlsbGluZyBNQ1AgU2VydmVyIFJ1bnRpbWVcbiAgICB0aGlzLmJpbGxpbmdNY3BSZXBvc2l0b3J5ID0gbmV3IGVjci5SZXBvc2l0b3J5KHRoaXMsICdCaWxsaW5nTWNwUmVwb3NpdG9yeScsIHtcbiAgICAgIHJlcG9zaXRvcnlOYW1lOiAnY2xvdWRvcHMtYmlsbGluZy1tY3AtcnVudGltZScsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgZW1wdHlPbkRlbGV0ZTogdHJ1ZSxcbiAgICAgIGltYWdlU2Nhbk9uUHVzaDogdHJ1ZSxcbiAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbeyBkZXNjcmlwdGlvbjogJ0tlZXAgbGFzdCAxMCBpbWFnZXMnLCBtYXhJbWFnZUNvdW50OiAxMCB9XSxcbiAgICB9KTtcblxuICAgIC8vIEVDUiBSZXBvc2l0b3J5IGZvciBQcmljaW5nIE1DUCBTZXJ2ZXIgUnVudGltZVxuICAgIHRoaXMucHJpY2luZ01jcFJlcG9zaXRvcnkgPSBuZXcgZWNyLlJlcG9zaXRvcnkodGhpcywgJ1ByaWNpbmdNY3BSZXBvc2l0b3J5Jywge1xuICAgICAgcmVwb3NpdG9yeU5hbWU6ICdjbG91ZG9wcy1wcmljaW5nLW1jcC1ydW50aW1lJyxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICBlbXB0eU9uRGVsZXRlOiB0cnVlLFxuICAgICAgaW1hZ2VTY2FuT25QdXNoOiB0cnVlLFxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFt7IGRlc2NyaXB0aW9uOiAnS2VlcCBsYXN0IDEwIGltYWdlcycsIG1heEltYWdlQ291bnQ6IDEwIH1dLFxuICAgIH0pO1xuXG4gICAgLy8gRUNSIFJlcG9zaXRvcnkgZm9yIENsb3VkV2F0Y2ggTUNQIFNlcnZlciBSdW50aW1lXG4gICAgdGhpcy5jbG91ZHdhdGNoTWNwUmVwb3NpdG9yeSA9IG5ldyBlY3IuUmVwb3NpdG9yeSh0aGlzLCAnQ2xvdWRXYXRjaE1jcFJlcG9zaXRvcnknLCB7XG4gICAgICByZXBvc2l0b3J5TmFtZTogJ2Nsb3Vkb3BzLWNsb3Vkd2F0Y2gtbWNwLXJ1bnRpbWUnLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGVtcHR5T25EZWxldGU6IHRydWUsXG4gICAgICBpbWFnZVNjYW5PblB1c2g6IHRydWUsXG4gICAgICBsaWZlY3ljbGVSdWxlczogW3sgZGVzY3JpcHRpb246ICdLZWVwIGxhc3QgMTAgaW1hZ2VzJywgbWF4SW1hZ2VDb3VudDogMTAgfV0sXG4gICAgfSk7XG5cbiAgICAvLyBFQ1IgUmVwb3NpdG9yeSBmb3IgQ2xvdWRUcmFpbCBNQ1AgU2VydmVyIFJ1bnRpbWVcbiAgICB0aGlzLmNsb3VkdHJhaWxNY3BSZXBvc2l0b3J5ID0gbmV3IGVjci5SZXBvc2l0b3J5KHRoaXMsICdDbG91ZFRyYWlsTWNwUmVwb3NpdG9yeScsIHtcbiAgICAgIHJlcG9zaXRvcnlOYW1lOiAnY2xvdWRvcHMtY2xvdWR0cmFpbC1tY3AtcnVudGltZScsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgZW1wdHlPbkRlbGV0ZTogdHJ1ZSxcbiAgICAgIGltYWdlU2Nhbk9uUHVzaDogdHJ1ZSxcbiAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbeyBkZXNjcmlwdGlvbjogJ0tlZXAgbGFzdCAxMCBpbWFnZXMnLCBtYXhJbWFnZUNvdW50OiAxMCB9XSxcbiAgICB9KTtcblxuICAgIC8vIEVDUiBSZXBvc2l0b3J5IGZvciBJbnZlbnRvcnkgTUNQIFNlcnZlciBSdW50aW1lXG4gICAgdGhpcy5pbnZlbnRvcnlNY3BSZXBvc2l0b3J5ID0gbmV3IGVjci5SZXBvc2l0b3J5KHRoaXMsICdJbnZlbnRvcnlNY3BSZXBvc2l0b3J5Jywge1xuICAgICAgcmVwb3NpdG9yeU5hbWU6ICdjbG91ZG9wcy1pbnZlbnRvcnktbWNwLXJ1bnRpbWUnLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGVtcHR5T25EZWxldGU6IHRydWUsXG4gICAgICBpbWFnZVNjYW5PblB1c2g6IHRydWUsXG4gICAgICBsaWZlY3ljbGVSdWxlczogW3sgZGVzY3JpcHRpb246ICdLZWVwIGxhc3QgMTAgaW1hZ2VzJywgbWF4SW1hZ2VDb3VudDogMTAgfV0sXG4gICAgfSk7XG5cbiAgICAvLyBEZWRpY2F0ZWQgYnVja2V0IHRvIHJlY2VpdmUgUzMgc2VydmVyIGFjY2VzcyBsb2dzIGZvciB0aGUgc291cmNlIGJ1Y2tldC5cbiAgICAvLyBJdCBsb2dzIHRvIGl0c2VsZiAodGVybWluYWwgbG9nIGJ1Y2tldCkgc28gaXQgYWxzbyBoYXMgYWNjZXNzIGxvZ2dpbmdcbiAgICAvLyBlbmFibGVkIHJhdGhlciB0aGFuIGJlaW5nIGFuIHVuLWxvZ2dlZCBidWNrZXQuXG4gICAgY29uc3QgYWNjZXNzTG9nc0J1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ1NvdXJjZUJ1Y2tldEFjY2Vzc0xvZ3MnLCB7XG4gICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgIC8vIFNlbGYtbG9nZ2luZzogd2l0aCBhIHByZWZpeCBidXQgbm8gc2VwYXJhdGUgdGFyZ2V0IGJ1Y2tldCwgQ0RLXG4gICAgICAvLyBjb25maWd1cmVzIHRoaXMgYnVja2V0IHRvIGRlbGl2ZXIgaXRzIG93biBhY2Nlc3MgbG9ncyB0byBpdHNlbGYsIHNvXG4gICAgICAvLyBldmVyeSBidWNrZXQgaW4gdGhlIHN0YWNrIGhhcyBhY2Nlc3MgbG9nZ2luZyBlbmFibGVkLlxuICAgICAgc2VydmVyQWNjZXNzTG9nc1ByZWZpeDogJ3NlbGYtYWNjZXNzLWxvZ3MvJyxcbiAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbXG4gICAgICAgIHsgaWQ6ICdEZWxldGVPbGRBY2Nlc3NMb2dzJywgZW5hYmxlZDogdHJ1ZSwgZXhwaXJhdGlvbjogY2RrLkR1cmF0aW9uLmRheXMoOTApIH0sXG4gICAgICBdLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGF1dG9EZWxldGVPYmplY3RzOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gUzMgQnVja2V0IGZvciBDb2RlQnVpbGQgc291cmNlIChidWlsZHNwZWMgKyBwYXRjaCBzY3JpcHRzKVxuICAgIHRoaXMuc291cmNlQnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnU291cmNlQnVja2V0Jywge1xuICAgICAgdmVyc2lvbmVkOiB0cnVlLFxuICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAvLyBTZXJ2ZXIgYWNjZXNzIGxvZ2dpbmcgZW5hYmxlZCAoZGVsaXZlcmVkIHRvIHRoZSBkZWRpY2F0ZWQgbG9nIGJ1Y2tldCkuXG4gICAgICBzZXJ2ZXJBY2Nlc3NMb2dzQnVja2V0OiBhY2Nlc3NMb2dzQnVja2V0LFxuICAgICAgc2VydmVyQWNjZXNzTG9nc1ByZWZpeDogJ3NvdXJjZS1idWNrZXQtYWNjZXNzLWxvZ3MvJyxcbiAgICAgIGxpZmVjeWNsZVJ1bGVzOiBbXG4gICAgICAgIHsgaWQ6ICdEZWxldGVPbGRWZXJzaW9ucycsIGVuYWJsZWQ6IHRydWUsIG5vbmN1cnJlbnRWZXJzaW9uRXhwaXJhdGlvbjogY2RrLkR1cmF0aW9uLmRheXMoMzApIH0sXG4gICAgICBdLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGF1dG9EZWxldGVPYmplY3RzOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gVXBsb2FkIGNvZGVidWlsZC1zY3JpcHRzIHRvIFMzXG4gICAgY29uc3Qgc2NyaXB0c0RlcGxveW1lbnQgPSBuZXcgczNkZXBsb3kuQnVja2V0RGVwbG95bWVudCh0aGlzLCAnQ29kZUJ1aWxkU2NyaXB0c0RlcGxveW1lbnQnLCB7XG4gICAgICBzb3VyY2VzOiBbczNkZXBsb3kuU291cmNlLmFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi8uLi9jb2RlYnVpbGQtc2NyaXB0cycpKV0sXG4gICAgICBkZXN0aW5hdGlvbkJ1Y2tldDogdGhpcy5zb3VyY2VCdWNrZXQsXG4gICAgICBkZXN0aW5hdGlvbktleVByZWZpeDogJ2NvZGVidWlsZC1zY3JpcHRzLycsXG4gICAgICBleHRyYWN0OiB0cnVlLFxuICAgICAgcHJ1bmU6IGZhbHNlLFxuICAgICAgcmV0YWluT25EZWxldGU6IGZhbHNlLFxuICAgICAgbWVtb3J5TGltaXQ6IDUxMixcbiAgICB9KTtcblxuICAgIC8vIEFsc28gdXBsb2FkIGFnZW50Y29yZSBkaXJlY3RvcnkgZm9yIG1haW4gcnVudGltZSBidWlsZFxuICAgIGNvbnN0IGFnZW50Y29yZURlcGxveW1lbnQgPSBuZXcgczNkZXBsb3kuQnVja2V0RGVwbG95bWVudCh0aGlzLCAnQWdlbnRjb3JlU291cmNlRGVwbG95bWVudCcsIHtcbiAgICAgIHNvdXJjZXM6IFtzM2RlcGxveS5Tb3VyY2UuYXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uLy4uL2FnZW50Y29yZScpKV0sXG4gICAgICBkZXN0aW5hdGlvbkJ1Y2tldDogdGhpcy5zb3VyY2VCdWNrZXQsXG4gICAgICBkZXN0aW5hdGlvbktleVByZWZpeDogJ2FnZW50Y29yZS8nLFxuICAgIH0pO1xuXG4gICAgLy8gVXBsb2FkIGludmVudG9yeSBNQ1Agc2VydmVyIHNvdXJjZSB0byBTM1xuICAgIGNvbnN0IGludmVudG9yeVNvdXJjZURlcGxveW1lbnQgPSBuZXcgczNkZXBsb3kuQnVja2V0RGVwbG95bWVudCh0aGlzLCAnSW52ZW50b3J5U291cmNlRGVwbG95bWVudCcsIHtcbiAgICAgIHNvdXJjZXM6IFtzM2RlcGxveS5Tb3VyY2UuYXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uLy4uL21jcC1zZXJ2ZXJzL2ludmVudG9yeScpKV0sXG4gICAgICBkZXN0aW5hdGlvbkJ1Y2tldDogdGhpcy5zb3VyY2VCdWNrZXQsXG4gICAgICBkZXN0aW5hdGlvbktleVByZWZpeDogJ2ludmVudG9yeS8nLFxuICAgIH0pO1xuXG4gICAgLy8gLS0tIEJ1aWxkIFRyaWdnZXIgTGFtYmRhIC0tLVxuICAgIGNvbnN0IGJ1aWxkVHJpZ2dlckZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnQnVpbGRUcmlnZ2VyRnVuY3Rpb24nLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xNCxcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vLi4vbGFtYmRhL2J1aWxkLXRyaWdnZXInKSksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcygxKSxcbiAgICAgIG1lbW9yeVNpemU6IDEyOCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVHJpZ2dlcnMgQ29kZUJ1aWxkIGJ1aWxkIGZvciBNQ1Agc2VydmVyIGNvbnRhaW5lcicsXG4gICAgfSk7XG5cbiAgICAvLyAtLS0gQnVpbGQgV2FpdGVyIExhbWJkYSAtLS1cbiAgICBjb25zdCBidWlsZFdhaXRlckZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnQnVpbGRXYWl0ZXJGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzE0LFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi8uLi9sYW1iZGEvYnVpbGQtd2FpdGVyJykpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMTUpLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgZGVzY3JpcHRpb246ICdQb2xscyBDb2RlQnVpbGQgYnVpbGQgc3RhdHVzIHVudGlsIGNvbXBsZXRpb24nLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIEJpbGxpbmcgTUNQIFNlcnZlciAtIENvZGVCdWlsZCArIFRyYW5zZm9ybVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBiaWxsaW5nQnVpbGRQcm9qZWN0ID0gdGhpcy5jcmVhdGVUcmFuc2Zvcm1CdWlsZFByb2plY3QoXG4gICAgICAnQmlsbGluZ01jcCcsXG4gICAgICB0aGlzLmJpbGxpbmdNY3BSZXBvc2l0b3J5LFxuICAgICAgJ2NvZGVidWlsZC1zY3JpcHRzLycsXG4gICAgICAnYnVpbGRzcGVjLWJpbGxpbmcueW1sJyxcbiAgICApO1xuICAgIGJpbGxpbmdCdWlsZFByb2plY3Qubm9kZS5hZGREZXBlbmRlbmN5KHNjcmlwdHNEZXBsb3ltZW50KTtcblxuICAgIC8vIEdyYW50IExhbWJkYSBwZXJtaXNzaW9uc1xuICAgIGJ1aWxkVHJpZ2dlckZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2NvZGVidWlsZDpTdGFydEJ1aWxkJ10sXG4gICAgICByZXNvdXJjZXM6IFtiaWxsaW5nQnVpbGRQcm9qZWN0LnByb2plY3RBcm5dLFxuICAgIH0pKTtcbiAgICBidWlsZFdhaXRlckZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2NvZGVidWlsZDpCYXRjaEdldEJ1aWxkcyddLFxuICAgICAgcmVzb3VyY2VzOiBbYmlsbGluZ0J1aWxkUHJvamVjdC5wcm9qZWN0QXJuXSxcbiAgICB9KSk7XG5cbiAgICAvLyBUcmlnZ2VyIGJpbGxpbmcgYnVpbGRcbiAgICBjb25zdCBiaWxsaW5nQnVpbGRUcmlnZ2VyID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnQmlsbGluZ0J1aWxkVHJpZ2dlcicsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogYnVpbGRUcmlnZ2VyRm4uZnVuY3Rpb25Bcm4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIFByb2plY3ROYW1lOiBiaWxsaW5nQnVpbGRQcm9qZWN0LnByb2plY3ROYW1lLFxuICAgICAgICBUaW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgYmlsbGluZ0J1aWxkVHJpZ2dlci5ub2RlLmFkZERlcGVuZGVuY3koc2NyaXB0c0RlcGxveW1lbnQpO1xuXG4gICAgLy8gV2FpdCBmb3IgYmlsbGluZyBidWlsZFxuICAgIGNvbnN0IGJpbGxpbmdCdWlsZFdhaXRlciA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ0JpbGxpbmdCdWlsZFdhaXRlcicsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogYnVpbGRXYWl0ZXJGbi5mdW5jdGlvbkFybixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgQnVpbGRJZDogYmlsbGluZ0J1aWxkVHJpZ2dlci5nZXRBdHRTdHJpbmcoJ0J1aWxkSWQnKSxcbiAgICAgICAgTWF4V2FpdFNlY29uZHM6ICcxMjAwJyxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgYmlsbGluZ0J1aWxkV2FpdGVyLm5vZGUuYWRkRGVwZW5kZW5jeShiaWxsaW5nQnVpbGRUcmlnZ2VyKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBQcmljaW5nIE1DUCBTZXJ2ZXIgLSBDb2RlQnVpbGQgKyBUcmFuc2Zvcm1cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgcHJpY2luZ0J1aWxkUHJvamVjdCA9IHRoaXMuY3JlYXRlVHJhbnNmb3JtQnVpbGRQcm9qZWN0KFxuICAgICAgJ1ByaWNpbmdNY3AnLFxuICAgICAgdGhpcy5wcmljaW5nTWNwUmVwb3NpdG9yeSxcbiAgICAgICdjb2RlYnVpbGQtc2NyaXB0cy8nLFxuICAgICAgJ2J1aWxkc3BlYy1wcmljaW5nLnltbCcsXG4gICAgKTtcbiAgICBwcmljaW5nQnVpbGRQcm9qZWN0Lm5vZGUuYWRkRGVwZW5kZW5jeShzY3JpcHRzRGVwbG95bWVudCk7XG5cbiAgICAvLyBHcmFudCBMYW1iZGEgcGVybWlzc2lvbnMgZm9yIHByaWNpbmdcbiAgICBidWlsZFRyaWdnZXJGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogWydjb2RlYnVpbGQ6U3RhcnRCdWlsZCddLFxuICAgICAgcmVzb3VyY2VzOiBbcHJpY2luZ0J1aWxkUHJvamVjdC5wcm9qZWN0QXJuXSxcbiAgICB9KSk7XG4gICAgYnVpbGRXYWl0ZXJGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogWydjb2RlYnVpbGQ6QmF0Y2hHZXRCdWlsZHMnXSxcbiAgICAgIHJlc291cmNlczogW3ByaWNpbmdCdWlsZFByb2plY3QucHJvamVjdEFybl0sXG4gICAgfSkpO1xuXG4gICAgLy8gVHJpZ2dlciBwcmljaW5nIGJ1aWxkXG4gICAgY29uc3QgcHJpY2luZ0J1aWxkVHJpZ2dlciA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ1ByaWNpbmdCdWlsZFRyaWdnZXInLCB7XG4gICAgICBzZXJ2aWNlVG9rZW46IGJ1aWxkVHJpZ2dlckZuLmZ1bmN0aW9uQXJuLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBQcm9qZWN0TmFtZTogcHJpY2luZ0J1aWxkUHJvamVjdC5wcm9qZWN0TmFtZSxcbiAgICAgICAgVGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICB9LFxuICAgIH0pO1xuICAgIHByaWNpbmdCdWlsZFRyaWdnZXIubm9kZS5hZGREZXBlbmRlbmN5KHNjcmlwdHNEZXBsb3ltZW50KTtcblxuICAgIC8vIFdhaXQgZm9yIHByaWNpbmcgYnVpbGRcbiAgICBjb25zdCBwcmljaW5nQnVpbGRXYWl0ZXIgPSBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdQcmljaW5nQnVpbGRXYWl0ZXInLCB7XG4gICAgICBzZXJ2aWNlVG9rZW46IGJ1aWxkV2FpdGVyRm4uZnVuY3Rpb25Bcm4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEJ1aWxkSWQ6IHByaWNpbmdCdWlsZFRyaWdnZXIuZ2V0QXR0U3RyaW5nKCdCdWlsZElkJyksXG4gICAgICAgIE1heFdhaXRTZWNvbmRzOiAnMTIwMCcsXG4gICAgICB9LFxuICAgIH0pO1xuICAgIHByaWNpbmdCdWlsZFdhaXRlci5ub2RlLmFkZERlcGVuZGVuY3kocHJpY2luZ0J1aWxkVHJpZ2dlcik7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ2xvdWRXYXRjaCBNQ1AgU2VydmVyIC0gQ29kZUJ1aWxkICsgVHJhbnNmb3JtXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNvbnN0IGNsb3Vkd2F0Y2hCdWlsZFByb2plY3QgPSB0aGlzLmNyZWF0ZVRyYW5zZm9ybUJ1aWxkUHJvamVjdChcbiAgICAgICdDbG91ZFdhdGNoTWNwJyxcbiAgICAgIHRoaXMuY2xvdWR3YXRjaE1jcFJlcG9zaXRvcnksXG4gICAgICAnY29kZWJ1aWxkLXNjcmlwdHMvJyxcbiAgICAgICdidWlsZHNwZWMtY2xvdWR3YXRjaC55bWwnLFxuICAgICk7XG4gICAgY2xvdWR3YXRjaEJ1aWxkUHJvamVjdC5ub2RlLmFkZERlcGVuZGVuY3koc2NyaXB0c0RlcGxveW1lbnQpO1xuXG4gICAgLy8gR3JhbnQgTGFtYmRhIHBlcm1pc3Npb25zIGZvciBDbG91ZFdhdGNoXG4gICAgYnVpbGRUcmlnZ2VyRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnY29kZWJ1aWxkOlN0YXJ0QnVpbGQnXSxcbiAgICAgIHJlc291cmNlczogW2Nsb3Vkd2F0Y2hCdWlsZFByb2plY3QucHJvamVjdEFybl0sXG4gICAgfSkpO1xuICAgIGJ1aWxkV2FpdGVyRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnY29kZWJ1aWxkOkJhdGNoR2V0QnVpbGRzJ10sXG4gICAgICByZXNvdXJjZXM6IFtjbG91ZHdhdGNoQnVpbGRQcm9qZWN0LnByb2plY3RBcm5dLFxuICAgIH0pKTtcblxuICAgIC8vIFRyaWdnZXIgQ2xvdWRXYXRjaCBidWlsZFxuICAgIGNvbnN0IGNsb3Vkd2F0Y2hCdWlsZFRyaWdnZXIgPSBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdDbG91ZFdhdGNoQnVpbGRUcmlnZ2VyJywge1xuICAgICAgc2VydmljZVRva2VuOiBidWlsZFRyaWdnZXJGbi5mdW5jdGlvbkFybixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgUHJvamVjdE5hbWU6IGNsb3Vkd2F0Y2hCdWlsZFByb2plY3QucHJvamVjdE5hbWUsXG4gICAgICAgIFRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBjbG91ZHdhdGNoQnVpbGRUcmlnZ2VyLm5vZGUuYWRkRGVwZW5kZW5jeShzY3JpcHRzRGVwbG95bWVudCk7XG5cbiAgICAvLyBXYWl0IGZvciBDbG91ZFdhdGNoIGJ1aWxkXG4gICAgY29uc3QgY2xvdWR3YXRjaEJ1aWxkV2FpdGVyID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnQ2xvdWRXYXRjaEJ1aWxkV2FpdGVyJywge1xuICAgICAgc2VydmljZVRva2VuOiBidWlsZFdhaXRlckZuLmZ1bmN0aW9uQXJuLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBCdWlsZElkOiBjbG91ZHdhdGNoQnVpbGRUcmlnZ2VyLmdldEF0dFN0cmluZygnQnVpbGRJZCcpLFxuICAgICAgICBNYXhXYWl0U2Vjb25kczogJzEyMDAnLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBjbG91ZHdhdGNoQnVpbGRXYWl0ZXIubm9kZS5hZGREZXBlbmRlbmN5KGNsb3Vkd2F0Y2hCdWlsZFRyaWdnZXIpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENsb3VkVHJhaWwgTUNQIFNlcnZlciAtIENvZGVCdWlsZCArIFRyYW5zZm9ybVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBjbG91ZHRyYWlsQnVpbGRQcm9qZWN0ID0gdGhpcy5jcmVhdGVUcmFuc2Zvcm1CdWlsZFByb2plY3QoXG4gICAgICAnQ2xvdWRUcmFpbE1jcCcsXG4gICAgICB0aGlzLmNsb3VkdHJhaWxNY3BSZXBvc2l0b3J5LFxuICAgICAgJ2NvZGVidWlsZC1zY3JpcHRzLycsXG4gICAgICAnYnVpbGRzcGVjLWNsb3VkdHJhaWwueW1sJyxcbiAgICApO1xuICAgIGNsb3VkdHJhaWxCdWlsZFByb2plY3Qubm9kZS5hZGREZXBlbmRlbmN5KHNjcmlwdHNEZXBsb3ltZW50KTtcblxuICAgIC8vIEdyYW50IExhbWJkYSBwZXJtaXNzaW9ucyBmb3IgQ2xvdWRUcmFpbFxuICAgIGJ1aWxkVHJpZ2dlckZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2NvZGVidWlsZDpTdGFydEJ1aWxkJ10sXG4gICAgICByZXNvdXJjZXM6IFtjbG91ZHRyYWlsQnVpbGRQcm9qZWN0LnByb2plY3RBcm5dLFxuICAgIH0pKTtcbiAgICBidWlsZFdhaXRlckZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2NvZGVidWlsZDpCYXRjaEdldEJ1aWxkcyddLFxuICAgICAgcmVzb3VyY2VzOiBbY2xvdWR0cmFpbEJ1aWxkUHJvamVjdC5wcm9qZWN0QXJuXSxcbiAgICB9KSk7XG5cbiAgICAvLyBUcmlnZ2VyIENsb3VkVHJhaWwgYnVpbGRcbiAgICBjb25zdCBjbG91ZHRyYWlsQnVpbGRUcmlnZ2VyID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnQ2xvdWRUcmFpbEJ1aWxkVHJpZ2dlcicsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogYnVpbGRUcmlnZ2VyRm4uZnVuY3Rpb25Bcm4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIFByb2plY3ROYW1lOiBjbG91ZHRyYWlsQnVpbGRQcm9qZWN0LnByb2plY3ROYW1lLFxuICAgICAgICBUaW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgY2xvdWR0cmFpbEJ1aWxkVHJpZ2dlci5ub2RlLmFkZERlcGVuZGVuY3koc2NyaXB0c0RlcGxveW1lbnQpO1xuXG4gICAgLy8gV2FpdCBmb3IgQ2xvdWRUcmFpbCBidWlsZFxuICAgIGNvbnN0IGNsb3VkdHJhaWxCdWlsZFdhaXRlciA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ0Nsb3VkVHJhaWxCdWlsZFdhaXRlcicsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogYnVpbGRXYWl0ZXJGbi5mdW5jdGlvbkFybixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgQnVpbGRJZDogY2xvdWR0cmFpbEJ1aWxkVHJpZ2dlci5nZXRBdHRTdHJpbmcoJ0J1aWxkSWQnKSxcbiAgICAgICAgTWF4V2FpdFNlY29uZHM6ICcxMjAwJyxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgY2xvdWR0cmFpbEJ1aWxkV2FpdGVyLm5vZGUuYWRkRGVwZW5kZW5jeShjbG91ZHRyYWlsQnVpbGRUcmlnZ2VyKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBJbnZlbnRvcnkgTUNQIFNlcnZlciAtIERpcmVjdCBEb2NrZXIgQnVpbGRcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgY29uc3QgaW52ZW50b3J5QnVpbGRSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdJbnZlbnRvcnlNY3BDb2RlQnVpbGRSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2NvZGVidWlsZC5hbWF6b25hd3MuY29tJyksXG4gICAgICBkZXNjcmlwdGlvbjogJ0lBTSByb2xlIGZvciBDb2RlQnVpbGQgdG8gYnVpbGQgSW52ZW50b3J5IE1DUCBjb250YWluZXIgaW1hZ2UnLFxuICAgICAgaW5saW5lUG9saWNpZXM6IHtcbiAgICAgICAgQ2xvdWRXYXRjaExvZ3NQb2xpY3k6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICBhY3Rpb25zOiBbJ2xvZ3M6Q3JlYXRlTG9nR3JvdXAnLCAnbG9nczpDcmVhdGVMb2dTdHJlYW0nLCAnbG9nczpQdXRMb2dFdmVudHMnXSxcbiAgICAgICAgICAgIHJlc291cmNlczogW2Bhcm46YXdzOmxvZ3M6JHtjZGsuQXdzLlJFR0lPTn06JHtjZGsuQXdzLkFDQ09VTlRfSUR9OmxvZy1ncm91cDovYXdzL2NvZGVidWlsZC8qYF0sXG4gICAgICAgICAgfSldLFxuICAgICAgICB9KSxcbiAgICAgICAgRUNSUHVzaFBvbGljeTogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAnZWNyOkJhdGNoQ2hlY2tMYXllckF2YWlsYWJpbGl0eScsICdlY3I6R2V0RG93bmxvYWRVcmxGb3JMYXllcicsICdlY3I6QmF0Y2hHZXRJbWFnZScsXG4gICAgICAgICAgICAgICAgJ2VjcjpQdXRJbWFnZScsICdlY3I6SW5pdGlhdGVMYXllclVwbG9hZCcsICdlY3I6VXBsb2FkTGF5ZXJQYXJ0JywgJ2VjcjpDb21wbGV0ZUxheWVyVXBsb2FkJyxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbdGhpcy5pbnZlbnRvcnlNY3BSZXBvc2l0b3J5LnJlcG9zaXRvcnlBcm5dLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogWydlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuJ10sXG4gICAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgICAgUzNSZWFkUG9saWN5OiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgYWN0aW9uczogWydzMzpHZXRPYmplY3QnLCAnczM6R2V0T2JqZWN0VmVyc2lvbiddLFxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbdGhpcy5zb3VyY2VCdWNrZXQuYXJuRm9yT2JqZWN0cygnKicpXSxcbiAgICAgICAgICB9KV0sXG4gICAgICAgIH0pLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGludmVudG9yeUJ1aWxkUHJvamVjdCA9IG5ldyBjb2RlYnVpbGQuUHJvamVjdCh0aGlzLCAnSW52ZW50b3J5TWNwQnVpbGRQcm9qZWN0Jywge1xuICAgICAgcHJvamVjdE5hbWU6ICdjbG91ZG9wcy1pbnZlbnRvcnltY3AtYnVpbGQnLFxuICAgICAgZGVzY3JpcHRpb246ICdCdWlsZCBBUk02NCBjb250YWluZXIgZm9yIEludmVudG9yeSBNQ1Agc2VydmVyJyxcbiAgICAgIHNvdXJjZTogY29kZWJ1aWxkLlNvdXJjZS5zMyh7XG4gICAgICAgIGJ1Y2tldDogdGhpcy5zb3VyY2VCdWNrZXQsXG4gICAgICAgIHBhdGg6ICdpbnZlbnRvcnkvJyxcbiAgICAgIH0pLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgYnVpbGRJbWFnZTogY29kZWJ1aWxkLkxpbnV4QXJtQnVpbGRJbWFnZS5BTUFaT05fTElOVVhfMl9TVEFOREFSRF8zXzAsXG4gICAgICAgIGNvbXB1dGVUeXBlOiBjb2RlYnVpbGQuQ29tcHV0ZVR5cGUuU01BTEwsXG4gICAgICAgIHByaXZpbGVnZWQ6IHRydWUsXG4gICAgICAgIGVudmlyb25tZW50VmFyaWFibGVzOiB7XG4gICAgICAgICAgQVdTX0RFRkFVTFRfUkVHSU9OOiB7IHZhbHVlOiBjZGsuQXdzLlJFR0lPTiB9LFxuICAgICAgICAgIEFXU19BQ0NPVU5UX0lEOiB7IHZhbHVlOiBjZGsuQXdzLkFDQ09VTlRfSUQgfSxcbiAgICAgICAgICBFQ1JfUkVQT19VUkk6IHsgdmFsdWU6IHRoaXMuaW52ZW50b3J5TWNwUmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgYnVpbGRTcGVjOiBjb2RlYnVpbGQuQnVpbGRTcGVjLmZyb21PYmplY3Qoe1xuICAgICAgICB2ZXJzaW9uOiAnMC4yJyxcbiAgICAgICAgcGhhc2VzOiB7XG4gICAgICAgICAgcHJlX2J1aWxkOiB7XG4gICAgICAgICAgICBjb21tYW5kczogW1xuICAgICAgICAgICAgICAnZWNobyBcIj09PSBQaGFzZSBQcmUtYnVpbGQgLSBFQ1IgTG9naW4gPT09XCInLFxuICAgICAgICAgICAgICAnYXdzIGVjciBnZXQtbG9naW4tcGFzc3dvcmQgLS1yZWdpb24gJEFXU19ERUZBVUxUX1JFR0lPTiB8IGRvY2tlciBsb2dpbiAtLXVzZXJuYW1lIEFXUyAtLXBhc3N3b3JkLXN0ZGluICRBV1NfQUNDT1VOVF9JRC5ka3IuZWNyLiRBV1NfREVGQVVMVF9SRUdJT04uYW1hem9uYXdzLmNvbScsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgYnVpbGQ6IHtcbiAgICAgICAgICAgIGNvbW1hbmRzOiBbXG4gICAgICAgICAgICAgICdlY2hvIFwiPT09IFBoYXNlIEJ1aWxkIC0gRG9ja2VyIGltYWdlID09PVwiJyxcbiAgICAgICAgICAgICAgJ2RvY2tlciBidWlsZCAtdCAkRUNSX1JFUE9fVVJJOiRDT0RFQlVJTERfQlVJTERfTlVNQkVSIC4nLFxuICAgICAgICAgICAgICAnZG9ja2VyIHRhZyAkRUNSX1JFUE9fVVJJOiRDT0RFQlVJTERfQlVJTERfTlVNQkVSICRFQ1JfUkVQT19VUkk6bGF0ZXN0JyxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICBwb3N0X2J1aWxkOiB7XG4gICAgICAgICAgICBjb21tYW5kczogW1xuICAgICAgICAgICAgICAnZWNobyBcIj09PSBQaGFzZSBQb3N0LWJ1aWxkIC0gUHVzaCB0byBFQ1IgPT09XCInLFxuICAgICAgICAgICAgICAnZG9ja2VyIHB1c2ggJEVDUl9SRVBPX1VSSTokQ09ERUJVSUxEX0JVSUxEX05VTUJFUicsXG4gICAgICAgICAgICAgICdkb2NrZXIgcHVzaCAkRUNSX1JFUE9fVVJJOmxhdGVzdCcsXG4gICAgICAgICAgICAgICdlY2hvIFwiSW52ZW50b3J5IE1DUCBpbWFnZSBwdXNoZWQgc3VjY2Vzc2Z1bGx5LlwiJyxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgcm9sZTogaW52ZW50b3J5QnVpbGRSb2xlLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMzApLFxuICAgIH0pO1xuICAgIGludmVudG9yeUJ1aWxkUHJvamVjdC5ub2RlLmFkZERlcGVuZGVuY3koaW52ZW50b3J5U291cmNlRGVwbG95bWVudCk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMoaW52ZW50b3J5QnVpbGRSb2xlLCBbXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLCByZWFzb246ICdXaWxkY2FyZCBmb3IgZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbiwgUzMsIENsb3VkV2F0Y2ggTG9ncy4nIH0sXG4gICAgXSwgdHJ1ZSk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMoaW52ZW50b3J5QnVpbGRQcm9qZWN0LCBbXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUNCNCcsIHJlYXNvbjogJ0tNUyBlbmNyeXB0aW9uIG5vdCBlbmFibGVkIGZvciBkZXYvZGVtby4nIH0sXG4gICAgXSk7XG5cbiAgICAvLyBHcmFudCBMYW1iZGEgcGVybWlzc2lvbnMgZm9yIEludmVudG9yeVxuICAgIGJ1aWxkVHJpZ2dlckZuLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2NvZGVidWlsZDpTdGFydEJ1aWxkJ10sXG4gICAgICByZXNvdXJjZXM6IFtpbnZlbnRvcnlCdWlsZFByb2plY3QucHJvamVjdEFybl0sXG4gICAgfSkpO1xuICAgIGJ1aWxkV2FpdGVyRm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFsnY29kZWJ1aWxkOkJhdGNoR2V0QnVpbGRzJ10sXG4gICAgICByZXNvdXJjZXM6IFtpbnZlbnRvcnlCdWlsZFByb2plY3QucHJvamVjdEFybl0sXG4gICAgfSkpO1xuXG4gICAgLy8gVHJpZ2dlciBJbnZlbnRvcnkgYnVpbGRcbiAgICBjb25zdCBpbnZlbnRvcnlCdWlsZFRyaWdnZXIgPSBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdJbnZlbnRvcnlCdWlsZFRyaWdnZXInLCB7XG4gICAgICBzZXJ2aWNlVG9rZW46IGJ1aWxkVHJpZ2dlckZuLmZ1bmN0aW9uQXJuLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBQcm9qZWN0TmFtZTogaW52ZW50b3J5QnVpbGRQcm9qZWN0LnByb2plY3ROYW1lLFxuICAgICAgICBUaW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgaW52ZW50b3J5QnVpbGRUcmlnZ2VyLm5vZGUuYWRkRGVwZW5kZW5jeShpbnZlbnRvcnlTb3VyY2VEZXBsb3ltZW50KTtcblxuICAgIC8vIFdhaXQgZm9yIEludmVudG9yeSBidWlsZFxuICAgIGNvbnN0IGludmVudG9yeUJ1aWxkV2FpdGVyID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnSW52ZW50b3J5QnVpbGRXYWl0ZXInLCB7XG4gICAgICBzZXJ2aWNlVG9rZW46IGJ1aWxkV2FpdGVyRm4uZnVuY3Rpb25Bcm4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEJ1aWxkSWQ6IGludmVudG9yeUJ1aWxkVHJpZ2dlci5nZXRBdHRTdHJpbmcoJ0J1aWxkSWQnKSxcbiAgICAgICAgTWF4V2FpdFNlY29uZHM6ICcxMjAwJyxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgaW52ZW50b3J5QnVpbGRXYWl0ZXIubm9kZS5hZGREZXBlbmRlbmN5KGludmVudG9yeUJ1aWxkVHJpZ2dlcik7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTWFpbiBBZ2VudCBSdW50aW1lIC0gU3RhbmRhcmQgRG9ja2VyIEJ1aWxkXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMuYnVpbGRNYWluUnVudGltZUltYWdlKGFnZW50Y29yZURlcGxveW1lbnQpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIE91dHB1dHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ01haW5SZXBvc2l0b3J5VXJpJywge1xuICAgICAgdmFsdWU6IHRoaXMucmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpLFxuICAgICAgZGVzY3JpcHRpb246ICdNYWluIFJ1bnRpbWUgRUNSIFJlcG9zaXRvcnkgVVJJJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1NYWluUmVwb3NpdG9yeVVyaWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQmlsbGluZ01jcFJlcG9zaXRvcnlVcmknLCB7XG4gICAgICB2YWx1ZTogdGhpcy5iaWxsaW5nTWNwUmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpLFxuICAgICAgZGVzY3JpcHRpb246ICdCaWxsaW5nIE1DUCBSdW50aW1lIEVDUiBSZXBvc2l0b3J5IFVSSScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQmlsbGluZ01jcFJlcG9zaXRvcnlVcmlgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1ByaWNpbmdNY3BSZXBvc2l0b3J5VXJpJywge1xuICAgICAgdmFsdWU6IHRoaXMucHJpY2luZ01jcFJlcG9zaXRvcnkucmVwb3NpdG9yeVVyaSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUHJpY2luZyBNQ1AgUnVudGltZSBFQ1IgUmVwb3NpdG9yeSBVUkknLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LVByaWNpbmdNY3BSZXBvc2l0b3J5VXJpYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdDbG91ZFdhdGNoTWNwUmVwb3NpdG9yeVVyaScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmNsb3Vkd2F0Y2hNY3BSZXBvc2l0b3J5LnJlcG9zaXRvcnlVcmksXG4gICAgICBkZXNjcmlwdGlvbjogJ0Nsb3VkV2F0Y2ggTUNQIFJ1bnRpbWUgRUNSIFJlcG9zaXRvcnkgVVJJJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1DbG91ZFdhdGNoTWNwUmVwb3NpdG9yeVVyaWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQ2xvdWRUcmFpbE1jcFJlcG9zaXRvcnlVcmknLCB7XG4gICAgICB2YWx1ZTogdGhpcy5jbG91ZHRyYWlsTWNwUmVwb3NpdG9yeS5yZXBvc2l0b3J5VXJpLFxuICAgICAgZGVzY3JpcHRpb246ICdDbG91ZFRyYWlsIE1DUCBSdW50aW1lIEVDUiBSZXBvc2l0b3J5IFVSSScsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tQ2xvdWRUcmFpbE1jcFJlcG9zaXRvcnlVcmlgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0ludmVudG9yeU1jcFJlcG9zaXRvcnlVcmknLCB7XG4gICAgICB2YWx1ZTogdGhpcy5pbnZlbnRvcnlNY3BSZXBvc2l0b3J5LnJlcG9zaXRvcnlVcmksXG4gICAgICBkZXNjcmlwdGlvbjogJ0ludmVudG9yeSBNQ1AgUnVudGltZSBFQ1IgUmVwb3NpdG9yeSBVUkknLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUludmVudG9yeU1jcFJlcG9zaXRvcnlVcmlgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1NvdXJjZUJ1Y2tldE5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5zb3VyY2VCdWNrZXQuYnVja2V0TmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUzMgYnVja2V0IGZvciBDb2RlQnVpbGQgc291cmNlIHNjcmlwdHMnLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENESy1OYWcgU3VwcHJlc3Npb25zXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhhY2Nlc3NMb2dzQnVja2V0LCBbXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLVMxJywgcmVhc29uOiAnVGVybWluYWwgYWNjZXNzLWxvZyBidWNrZXQ7IGl0IGxvZ3MgdG8gaXRzZWxmIChzZXJ2ZXJBY2Nlc3NMb2dzUHJlZml4IHNldCksIHNvIGFjY2VzcyBsb2dnaW5nIGlzIGVuYWJsZWQuJyB9LFxuICAgIF0pO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFN0YWNrU3VwcHJlc3Npb25zKHRoaXMsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtTDEnLCByZWFzb246ICdMYW1iZGEgcnVudGltZSB2ZXJzaW9uIG1hbmFnZWQgYnkgQ0RLLicgfSxcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNCcsIHJlYXNvbjogJ0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZSBpcyBBV1MgYmVzdCBwcmFjdGljZS4nIH0sXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLCByZWFzb246ICdXaWxkY2FyZCBwZXJtaXNzaW9ucyByZXF1aXJlZCBmb3IgUzMsIEVDUiwgQ2xvdWRXYXRjaCwgQ29kZUJ1aWxkLicgfSxcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtQ0I0JywgcmVhc29uOiAnS01TIGVuY3J5cHRpb24gbm90IGVuYWJsZWQgZm9yIGRldi9kZW1vLicgfSxcbiAgICBdKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDcmVhdGUgYSBDb2RlQnVpbGQgcHJvamVjdCB0aGF0IGNsb25lcyB1cHN0cmVhbSBNQ1AgcmVwbyxcbiAgICogYXBwbGllcyBwYXRjaCBzY3JpcHRzLCBidWlsZHMgQVJNNjQgRG9ja2VyIGltYWdlLFxuICAgKiBhbmQgcHVzaGVzIHRvIEVDUi5cbiAgICovXG4gIHByaXZhdGUgY3JlYXRlVHJhbnNmb3JtQnVpbGRQcm9qZWN0KFxuICAgIGlkOiBzdHJpbmcsXG4gICAgcmVwb3NpdG9yeTogZWNyLlJlcG9zaXRvcnksXG4gICAgc291cmNlUGF0aDogc3RyaW5nLFxuICAgIGJ1aWxkc3BlY0ZpbGU6IHN0cmluZyxcbiAgKTogY29kZWJ1aWxkLlByb2plY3Qge1xuICAgIGNvbnN0IGNvZGVCdWlsZFJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgYCR7aWR9Q29kZUJ1aWxkUm9sZWAsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdjb2RlYnVpbGQuYW1hem9uYXdzLmNvbScpLFxuICAgICAgZGVzY3JpcHRpb246IGBJQU0gcm9sZSBmb3IgQ29kZUJ1aWxkIHRvIGJ1aWxkICR7aWR9IGNvbnRhaW5lciBpbWFnZWAsXG4gICAgICBpbmxpbmVQb2xpY2llczoge1xuICAgICAgICBDbG91ZFdhdGNoTG9nc1BvbGljeTogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW25ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgIGFjdGlvbnM6IFsnbG9nczpDcmVhdGVMb2dHcm91cCcsICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsICdsb2dzOlB1dExvZ0V2ZW50cyddLFxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6bG9nczoke2Nkay5Bd3MuUkVHSU9OfToke2Nkay5Bd3MuQUNDT1VOVF9JRH06bG9nLWdyb3VwOi9hd3MvY29kZWJ1aWxkLypgXSxcbiAgICAgICAgICB9KV0sXG4gICAgICAgIH0pLFxuICAgICAgICBFQ1JQdXNoUG9saWN5OiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdlY3I6QmF0Y2hDaGVja0xheWVyQXZhaWxhYmlsaXR5JywgJ2VjcjpHZXREb3dubG9hZFVybEZvckxheWVyJywgJ2VjcjpCYXRjaEdldEltYWdlJyxcbiAgICAgICAgICAgICAgICAnZWNyOlB1dEltYWdlJywgJ2VjcjpJbml0aWF0ZUxheWVyVXBsb2FkJywgJ2VjcjpVcGxvYWRMYXllclBhcnQnLCAnZWNyOkNvbXBsZXRlTGF5ZXJVcGxvYWQnLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFtyZXBvc2l0b3J5LnJlcG9zaXRvcnlBcm5dLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogWydlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuJ10sXG4gICAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgICAgUzNSZWFkUG9saWN5OiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgYWN0aW9uczogWydzMzpHZXRPYmplY3QnLCAnczM6R2V0T2JqZWN0VmVyc2lvbiddLFxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbdGhpcy5zb3VyY2VCdWNrZXQuYXJuRm9yT2JqZWN0cygnKicpXSxcbiAgICAgICAgICB9KV0sXG4gICAgICAgIH0pLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHByb2plY3QgPSBuZXcgY29kZWJ1aWxkLlByb2plY3QodGhpcywgYCR7aWR9QnVpbGRQcm9qZWN0YCwge1xuICAgICAgcHJvamVjdE5hbWU6IGBjbG91ZG9wcy0ke2lkLnRvTG93ZXJDYXNlKCl9LWJ1aWxkYCxcbiAgICAgIGRlc2NyaXB0aW9uOiBgQnVpbGQgQVJNNjQgY29udGFpbmVyIGZvciAke2lkfSB3aXRoIHN0cmVhbWFibGUtaHR0cCB0cmFuc3BvcnRgLFxuICAgICAgc291cmNlOiBjb2RlYnVpbGQuU291cmNlLnMzKHtcbiAgICAgICAgYnVja2V0OiB0aGlzLnNvdXJjZUJ1Y2tldCxcbiAgICAgICAgcGF0aDogc291cmNlUGF0aCxcbiAgICAgIH0pLFxuICAgICAgYnVpbGRTcGVjOiBjb2RlYnVpbGQuQnVpbGRTcGVjLmZyb21Tb3VyY2VGaWxlbmFtZShidWlsZHNwZWNGaWxlKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIGJ1aWxkSW1hZ2U6IGNvZGVidWlsZC5MaW51eEFybUJ1aWxkSW1hZ2UuQU1BWk9OX0xJTlVYXzJfU1RBTkRBUkRfM18wLFxuICAgICAgICBjb21wdXRlVHlwZTogY29kZWJ1aWxkLkNvbXB1dGVUeXBlLlNNQUxMLFxuICAgICAgICBwcml2aWxlZ2VkOiB0cnVlLFxuICAgICAgICBlbnZpcm9ubWVudFZhcmlhYmxlczoge1xuICAgICAgICAgIEFXU19ERUZBVUxUX1JFR0lPTjogeyB2YWx1ZTogY2RrLkF3cy5SRUdJT04gfSxcbiAgICAgICAgICBBV1NfQUNDT1VOVF9JRDogeyB2YWx1ZTogY2RrLkF3cy5BQ0NPVU5UX0lEIH0sXG4gICAgICAgICAgRUNSX1JFUE9fVVJJOiB7IHZhbHVlOiByZXBvc2l0b3J5LnJlcG9zaXRvcnlVcmkgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICByb2xlOiBjb2RlQnVpbGRSb2xlLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMzApLFxuICAgIH0pO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKGNvZGVCdWlsZFJvbGUsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsIHJlYXNvbjogJ1dpbGRjYXJkIGZvciBlY3I6R2V0QXV0aG9yaXphdGlvblRva2VuLCBTMywgQ2xvdWRXYXRjaCBMb2dzLicgfSxcbiAgICBdLCB0cnVlKTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhwcm9qZWN0LCBbXG4gICAgICB7IGlkOiAnQXdzU29sdXRpb25zLUNCNCcsIHJlYXNvbjogJ0tNUyBlbmNyeXB0aW9uIG5vdCBlbmFibGVkIGZvciBkZXYvZGVtby4nIH0sXG4gICAgXSk7XG5cbiAgICByZXR1cm4gcHJvamVjdDtcbiAgfVxuXG4gIC8qKlxuICAgKiBCdWlsZCB0aGUgbWFpbiBhZ2VudCBydW50aW1lIGltYWdlIHVzaW5nIHN0YW5kYXJkIERvY2tlciBidWlsZFxuICAgKiAobm8gcGF0Y2hpbmcgbmVlZGVkIC0gaXQncyBvdXIgb3duIGNvZGUpLlxuICAgKi9cbiAgcHJpdmF0ZSBidWlsZE1haW5SdW50aW1lSW1hZ2Uoc291cmNlRGVwbG95bWVudDogczNkZXBsb3kuQnVja2V0RGVwbG95bWVudCk6IHZvaWQge1xuICAgIGNvbnN0IGJ1aWxkUHJvamVjdCA9IG5ldyBjb2RlYnVpbGQuUHJvamVjdCh0aGlzLCAnTWFpblJ1bnRpbWVCdWlsZFByb2plY3QnLCB7XG4gICAgICBwcm9qZWN0TmFtZTogJ2Nsb3Vkb3BzLW1haW5ydW50aW1lLWJ1aWxkJyxcbiAgICAgIHNvdXJjZTogY29kZWJ1aWxkLlNvdXJjZS5zMyh7XG4gICAgICAgIGJ1Y2tldDogdGhpcy5zb3VyY2VCdWNrZXQsXG4gICAgICAgIHBhdGg6ICdhZ2VudGNvcmUvJyxcbiAgICAgIH0pLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgYnVpbGRJbWFnZTogY29kZWJ1aWxkLkxpbnV4QnVpbGRJbWFnZS5BTUFaT05fTElOVVhfMl9BUk1fMyxcbiAgICAgICAgcHJpdmlsZWdlZDogdHJ1ZSxcbiAgICAgICAgY29tcHV0ZVR5cGU6IGNvZGVidWlsZC5Db21wdXRlVHlwZS5TTUFMTCxcbiAgICAgIH0sXG4gICAgICBlbnZpcm9ubWVudFZhcmlhYmxlczoge1xuICAgICAgICBBV1NfREVGQVVMVF9SRUdJT046IHsgdmFsdWU6IHRoaXMucmVnaW9uIH0sXG4gICAgICAgIEFXU19BQ0NPVU5UX0lEOiB7IHZhbHVlOiB0aGlzLmFjY291bnQgfSxcbiAgICAgICAgSU1BR0VfUkVQT19OQU1FOiB7IHZhbHVlOiB0aGlzLnJlcG9zaXRvcnkucmVwb3NpdG9yeU5hbWUgfSxcbiAgICAgICAgSU1BR0VfVEFHOiB7IHZhbHVlOiAnbGF0ZXN0JyB9LFxuICAgICAgfSxcbiAgICAgIGJ1aWxkU3BlYzogY29kZWJ1aWxkLkJ1aWxkU3BlYy5mcm9tT2JqZWN0KHtcbiAgICAgICAgdmVyc2lvbjogJzAuMicsXG4gICAgICAgIHBoYXNlczoge1xuICAgICAgICAgIHByZV9idWlsZDoge1xuICAgICAgICAgICAgY29tbWFuZHM6IFtcbiAgICAgICAgICAgICAgJ2VjaG8gTG9nZ2luZyBpbiB0byBBbWF6b24gRUNSLi4uJyxcbiAgICAgICAgICAgICAgJ2F3cyBlY3IgZ2V0LWxvZ2luLXBhc3N3b3JkIC0tcmVnaW9uICRBV1NfREVGQVVMVF9SRUdJT04gfCBkb2NrZXIgbG9naW4gLS11c2VybmFtZSBBV1MgLS1wYXNzd29yZC1zdGRpbiAkQVdTX0FDQ09VTlRfSUQuZGtyLmVjci4kQVdTX0RFRkFVTFRfUkVHSU9OLmFtYXpvbmF3cy5jb20nLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIGJ1aWxkOiB7XG4gICAgICAgICAgICBjb21tYW5kczogW1xuICAgICAgICAgICAgICAnZWNobyBCdWlsZGluZyB0aGUgRG9ja2VyIGltYWdlLi4uJyxcbiAgICAgICAgICAgICAgJ2RvY2tlciBidWlsZCAtdCAkSU1BR0VfUkVQT19OQU1FOiRJTUFHRV9UQUcgLicsXG4gICAgICAgICAgICAgICdkb2NrZXIgdGFnICRJTUFHRV9SRVBPX05BTUU6JElNQUdFX1RBRyAkQVdTX0FDQ09VTlRfSUQuZGtyLmVjci4kQVdTX0RFRkFVTFRfUkVHSU9OLmFtYXpvbmF3cy5jb20vJElNQUdFX1JFUE9fTkFNRTokSU1BR0VfVEFHJyxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICBwb3N0X2J1aWxkOiB7XG4gICAgICAgICAgICBjb21tYW5kczogW1xuICAgICAgICAgICAgICAnZWNobyBQdXNoaW5nIHRoZSBEb2NrZXIgaW1hZ2UuLi4nLFxuICAgICAgICAgICAgICAnZG9ja2VyIHB1c2ggJEFXU19BQ0NPVU5UX0lELmRrci5lY3IuJEFXU19ERUZBVUxUX1JFR0lPTi5hbWF6b25hd3MuY29tLyRJTUFHRV9SRVBPX05BTUU6JElNQUdFX1RBRycsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIHRoaXMucmVwb3NpdG9yeS5ncmFudFB1bGxQdXNoKGJ1aWxkUHJvamVjdCk7XG4gICAgdGhpcy5zb3VyY2VCdWNrZXQuZ3JhbnRSZWFkKGJ1aWxkUHJvamVjdCk7XG4gICAgYnVpbGRQcm9qZWN0LmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2VjcjpHZXRBdXRob3JpemF0aW9uVG9rZW4nXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuXG4gICAgY29uc3QgdHJpZ2dlckZuID0gbmV3IGNkay5hd3NfbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdNYWluUnVudGltZUJ1aWxkVHJpZ2dlckZuJywge1xuICAgICAgcnVudGltZTogY2RrLmF3c19sYW1iZGEuUnVudGltZS5QWVRIT05fM18xNCxcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGNkay5hd3NfbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi8uLi9sYW1iZGEvYnVpbGQtdHJpZ2dlcicpKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDEpLFxuICAgIH0pO1xuICAgIHRyaWdnZXJGbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogWydjb2RlYnVpbGQ6U3RhcnRCdWlsZCddLFxuICAgICAgcmVzb3VyY2VzOiBbYnVpbGRQcm9qZWN0LnByb2plY3RBcm5dLFxuICAgIH0pKTtcbiAgICB0cmlnZ2VyRm4ubm9kZS5hZGREZXBlbmRlbmN5KHNvdXJjZURlcGxveW1lbnQpO1xuXG4gICAgbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnTWFpblJ1bnRpbWVUcmlnZ2VyQnVpbGQnLCB7XG4gICAgICBzZXJ2aWNlVG9rZW46IHRyaWdnZXJGbi5mdW5jdGlvbkFybixcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgUHJvamVjdE5hbWU6IGJ1aWxkUHJvamVjdC5wcm9qZWN0TmFtZSxcbiAgICAgICAgVGltZXN0YW1wOiBgJHtEYXRlLm5vdygpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZyg3KX1gLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhidWlsZFByb2plY3QsIFtcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtQ0I0JywgcmVhc29uOiAnS01TIGVuY3J5cHRpb24gbm90IGVuYWJsZWQgZm9yIGRldi9kZW1vLicgfSxcbiAgICAgIHsgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsIHJlYXNvbjogJ1dpbGRjYXJkIGZvciBFQ1IsIFMzLCBDbG91ZFdhdGNoLicgfSxcbiAgICBdLCB0cnVlKTtcbiAgfVxufVxuIl19