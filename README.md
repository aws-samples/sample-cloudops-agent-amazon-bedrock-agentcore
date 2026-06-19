# CloudOps Agent – Agentic AI powered by Amazon Bedrock AgentCore

An AI-powered CloudOps assistant that helps operations and finance teams manage AWS costs, monitor infrastructure health, audit account activity, and track cluster inventory — all through a conversational interface.

## Architecture Overview

The solution has three main components:

| Layer                    | Technology                                                              | Purpose                                            |
| ------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------- |
| **Backend**              | AgentCore Runtime + Strands Agent SDK + MCP tools via AgentCore Gateway | AI agent orchestration and AWS service querying    |
| **Frontend**             | React SPA on AWS Amplify Hosting                                        | Modern chat interface with conversation management |
| **Conversation History** | DynamoDB + API Gateway + Lambda                                         | Persistent, multi-user conversation storage        |

### Detailed Architecture

```mermaid
flowchart TB
    subgraph User["End User"]
        Browser["Browser"]
    end

    subgraph Frontend["Frontend (AWS Amplify Hosting)"]
        ReactApp["React SPA<br/>TypeScript + Vite"]
        AuthUI["Amplify Authenticator<br/>(Custom Branded Login)"]
        ChatUI["Chat Interface<br/>(Sidebar + Messages + Markdown)"]
        ConvService["Conversation Service"]
    end

    subgraph Auth["Authentication"]
        Cognito["Amazon Cognito<br/>User Pool + Identity Pool"]
    end

    subgraph ConvAPI["Conversation History"]
        APIGW["API Gateway<br/>(REST + Cognito Auth)"]
        ConvLambda["Lambda<br/>(Python CRUD)"]
        DDB["DynamoDB<br/>(userId PK + conversationId SK)"]
    end

    subgraph AgentCore["Amazon Bedrock AgentCore"]
        Runtime["Agent Runtime<br/>(Strands Agent + Claude Sonnet)"]
        Memory["AgentCore Memory<br/>(Session Context)"]
        Gateway["AgentCore Gateway<br/>(Tool Discovery + Routing)"]
    end

    subgraph MCPServers["MCP Server Runtimes"]
        Billing["Billing MCP<br/>(Cost Explorer, Budgets,<br/>Compute Optimizer)"]
        Pricing["Pricing MCP<br/>(AWS Pricing API)"]
        CloudWatch["CloudWatch MCP<br/>(Metrics, Alarms,<br/>Logs Insights)"]
        CloudTrail["CloudTrail MCP<br/>(Event Lookups,<br/>Audit Trail)"]
        Inventory["Inventory MCP<br/>(EKS, RDS, OpenSearch,<br/>ElastiCache, MSK)"]
    end

    subgraph AWSServices["AWS Services"]
        CostExplorer["Cost Explorer"]
        CW["CloudWatch"]
        CT["CloudTrail"]
        EKS["EKS"]
        RDS["RDS/Aurora"]
        OS["OpenSearch"]
        EC["ElastiCache"]
        MSK["MSK"]
        EOLTable["DynamoDB<br/>(EOL Schedules)"]
    end

    Browser --> AuthUI
    AuthUI --> Cognito
    Cognito --> ChatUI
    ChatUI -->|"SigV4 signed POST"| Runtime
    ChatUI --> ConvService
    ConvService -->|"JWT Token"| APIGW
    APIGW --> ConvLambda
    ConvLambda --> DDB

    Runtime --> Memory
    Runtime -->|"Tool calls"| Gateway
    Gateway -->|"OAuth + JWT"| Billing
    Gateway -->|"OAuth + JWT"| Pricing
    Gateway -->|"OAuth + JWT"| CloudWatch
    Gateway -->|"OAuth + JWT"| CloudTrail
    Gateway -->|"OAuth + JWT"| Inventory

    Billing --> CostExplorer
    CloudWatch --> CW
    CloudTrail --> CT
    Inventory --> EKS
    Inventory --> RDS
    Inventory --> OS
    Inventory --> EC
    Inventory --> MSK
    Inventory --> EOLTable
```

### Request Flow

```mermaid
sequenceDiagram
    participant U as User (Browser)
    participant F as Frontend (React)
    participant C as Cognito
    participant R as AgentCore Runtime
    participant G as Gateway
    participant M as MCP Server
    participant D as DynamoDB (Conversations)

    U->>F: Enter query
    F->>D: Save user message (POST /conversations/{id})
    F->>R: POST /runtimes/{arn}/invocations (SigV4)
    Note over F: Shows "Working..." indicator

    R->>G: Discover tools (x_amz_bedrock_agentcore_search)
    G-->>R: Available tool names
    R->>G: Call tool (e.g., billingMcp___get_costs)
    G->>M: Forward to MCP server (OAuth)
    M-->>G: Tool result
    G-->>R: Response

    R-->>F: Streaming response (JSON with result)
    F->>D: Save agent message (PUT /conversations/{id})
    F->>U: Render markdown response
```

#### Step-by-Step Walkthrough

1. **User submits a query** — The user types a question (e.g. "Which RDS instances are approaching end of support?") into the React chat interface and presses send.
2. **Persist the user message** — The frontend immediately saves the user's message to DynamoDB via `POST /conversations/{id}`, so the conversation survives reloads even before the agent responds.
3. **Invoke the agent** — The frontend sends the query to the AgentCore Runtime with a SigV4-signed `POST /runtimes/{arn}/invocations` request. The user's Cognito credentials authorize the call. A "Working..." indicator is shown while the request is in flight.
4. **Tool discovery** — The Strands agent in the Runtime asks the AgentCore Gateway which tools are available (`x_amz_bedrock_agentcore_search`). The Gateway returns the set of MCP tool names across all registered servers (Billing, Pricing, CloudWatch, CloudTrail, Inventory).
5. **Reasoning and tool selection** — Claude Sonnet reasons over the query and the available tools, then decides which tool(s) to call and with what arguments (e.g. `inventoryMcp___list_rds_instances`).
6. **Tool invocation** — The Runtime calls the chosen tool through the Gateway. The Gateway forwards the request to the appropriate MCP server runtime over an OAuth-authenticated connection.
7. **MCP server queries AWS** — The MCP server calls the relevant AWS APIs (and, for Inventory, enriches results with end-of-support dates read from the `aws-eol-schedules` DynamoDB table) and returns a structured result to the Gateway, which relays it back to the Runtime.
8. **Response synthesis** — The agent may loop through steps 5–7 multiple times if more data is needed, then composes a final natural-language answer (often containing markdown tables or code blocks).
9. **Stream back to the frontend** — The Runtime streams the JSON response back to the frontend, which renders the markdown answer for the user.
10. **Persist the agent message** — The frontend saves the agent's response to DynamoDB via `PUT /conversations/{id}`, completing the conversation turn.

#### Authentication & Authorization

The request path crosses three trust boundaries, each using a different mechanism. No long-lived AWS keys are used anywhere in the flow — every hop relies on short-lived tokens or temporary credentials.

| Hop                           | Mechanism                       | Credential / token                                                                                                                                             |
| ----------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User → Frontend               | Cognito User Pool sign-in       | User signs in via the Amplify Authenticator and receives Cognito **ID + access JWTs** (`openid`, `email`, `profile`)                                           |
| Frontend → Conversation API   | Cognito JWT (API Gateway)       | The Cognito **ID token** is sent as the `Authorization` header; an API Gateway **Cognito User Pools Authorizer** validates it                                  |
| Frontend → AgentCore Runtime  | IAM / SigV4                     | The Identity Pool exchanges the authenticated identity for **temporary STS credentials** (the `AuthenticatedRole`), used to SigV4-sign `InvokeAgentRuntime`    |
| Runtime → Gateway             | IAM / SigV4                     | The Runtime's **execution role** (`InvokeGateway` permission) signs the call; the Gateway's authorizer type is `AWS_IAM`                                       |
| Gateway → MCP Server Runtimes | OAuth 2.0 bearer (client creds) | The Gateway exchanges the **M2M client ID + secret** for a Cognito **OAuth access token** (scope `mcp-runtime-server/invoke`) and sends it as a `Bearer` token |
| MCP Server → AWS service APIs | IAM / SigV4                     | Each MCP Runtime's **own execution role** (read-only scoped) signs the AWS API calls and DynamoDB reads                                                        |

**Token exchange details:**

1. **User identity (Cognito).** After sign-in, Cognito issues JWTs. The Cognito **Identity Pool** then federates that identity through STS `AssumeRoleWithWebIdentity` to mint **temporary AWS credentials** bound to the `AuthenticatedRole`. That role allows `bedrock-agentcore:InvokeAgentRuntime` (plus `GetRuntime`/`ListRuntimes`) scoped to the `cloudops_*` runtimes — unauthenticated identities are explicitly denied everything.

2. **Two parallel paths from the frontend.** Conversation history calls go to **API Gateway**, which validates the raw **Cognito JWT** (no IAM involved). Agent invocations go to the **AgentCore Runtime** using **SigV4** signed with the temporary credentials. These are deliberately separate: data persistence is user-scoped via JWT claims, while agent invocation is gated by IAM.

3. **Runtime to Gateway (IAM).** The main agent Runtime assumes its **execution role** to call the Gateway. The Gateway is configured with `AuthorizerType: AWS_IAM`, so it authorizes the caller by IAM principal — no token is passed here.

4. **Gateway to MCP servers (OAuth token exchange).** This is the only OAuth hop. Each Gateway target is wired to an **OAuth2 credential provider** backed by a Cognito **machine-to-machine (M2M) app client** using the `client_credentials` grant. The M2M client secret is stored in **Secrets Manager**; AgentCore Identity (`GetResourceOauth2Token` / `GetWorkloadAccessToken`) performs the exchange against the Cognito **token endpoint** and caches the resulting bearer token. The Gateway attaches that token to each MCP request.

5. **MCP server JWT validation.** Every MCP Runtime is deployed with a `CustomJWTAuthorizer` configured with the Cognito **OpenID discovery URL** and an `AllowedClients` allowlist containing the M2M client ID. It validates the incoming bearer token's signature (against Cognito's JWKS), issuer, and client ID before serving any tool call.

6. **MCP server to AWS (least privilege).** Once authorized, the MCP server uses **its own runtime execution role** to call AWS — these roles are read-only and tightly scoped (e.g. the Inventory role grants only `eks:*`/`rds:Describe*`/`es:*`/`elasticache:*`/`kafka:*` describe-style actions plus `dynamodb:GetItem`/`Query`/`Scan` on the EOL table). The EOL scraper Lambda runs under a separate role with write access to the EOL table and the `Describe*Versions` APIs.

## Features

### CloudOps AI Assistant

- **Cost Optimization** — Query AWS Cost Explorer, Budgets, Compute Optimizer, Savings Plans, and cost anomalies
- **CloudWatch Monitoring** — Metrics, alarms, log groups, and Logs Insights queries
- **CloudTrail Auditing** — API activity lookups, trail status, IAM change tracking
- **Cluster Inventory** — EKS, RDS/Aurora, OpenSearch, ElastiCache, MSK with version lifecycle tracking

### MCP Servers

Five Model Context Protocol servers provide 30+ specialized tools:

| Server         | Capabilities                                                                               |
| -------------- | ------------------------------------------------------------------------------------------ |
| **Billing**    | Cost Explorer, Budgets, Compute Optimizer, Savings Plans, Free Tier, Anomalies             |
| **CloudTrail** | Event lookups, trail management, audit queries                                             |
| **CloudWatch** | Metrics, alarms, log groups, Logs Insights queries                                         |
| **Inventory**  | EKS, RDS/Aurora, OpenSearch, ElastiCache, MSK clusters with end-of-support date monitoring |
| **Pricing**    | AWS Pricing API for service comparison                                                     |

### Frontend UI

- Custom login page with branding (gradient background, ✦ sparkle logo, app title)
- Dark sidebar with conversation history (create, rename, delete, switch between conversations)
- "Working..." indicator with animated ellipsis during agent processing
- Rich markdown rendering (tables, code blocks with copy button, nested lists, headings)
- Cancel request (■ Stop button) to abort in-flight agent calls
- Settings configuration (Cognito, AgentCore, Conversation History API endpoint)
- Sign out
- Responsive layout — sidebar collapses to hamburger menu on mobile (< 1024px)
- Avatars: ✦ sparkle on purple gradient for AI, "You" on light indigo for user
- Soft light blue user bubbles (#e8f0fe), white agent bubbles, indigo/purple accents

### Conversation History

- Persistent conversation storage in DynamoDB, scoped per user via Cognito
- Create, rename, delete, and switch between conversations from the sidebar
- Auto-save messages on send (immediate persistence, not polling-based)
- Multi-user isolation — each user only sees their own conversations
- Conversations survive logout/login and work across devices

### Authentication

- Amazon Cognito User Pool + Identity Pool
- Custom branded Amplify Authenticator login page
- Multi-user isolation for all data

## Tech Stack

| Component        | Technology                                   |
| ---------------- | -------------------------------------------- |
| Frontend         | React 18 + TypeScript + Vite                 |
| Infrastructure   | AWS CDK (TypeScript)                         |
| Agent Runtime    | Python (Strands Agent SDK)                   |
| MCP Servers      | Python (hosted on AgentCore Runtime)         |
| Conversation API | Python Lambda + API Gateway + DynamoDB       |
| Auth             | Amazon Cognito                               |
| AI               | Amazon Bedrock (Claude Sonnet) via AgentCore |
| Hosting          | AWS Amplify Hosting (static SPA)             |

## Deployment

### CDK Stacks

Deploy via `npx cdk deploy --all` from the `cdk/` directory. Six stacks are provisioned:

1. **ImageStack** — ECR repositories + CodeBuild projects for container images
2. **AuthStack** — Cognito User Pool, Identity Pool, M2M client, IAM roles
3. **MCPRuntimeStack** — AgentCore Runtimes for Billing, Pricing, CloudWatch, CloudTrail, Inventory MCP servers
4. **AgentCoreGatewayStack** — Unified tool discovery/invocation endpoint with OAuth
5. **AgentRuntimeStack** — Main Strands agent with Gateway integration and AgentCore Memory
6. **ConversationHistoryStack** — DynamoDB table + API Gateway + Lambda for conversation persistence

### Frontend

```bash
cd frontend
npm install
npm run build
npm run zip
```

Upload the generated zip to AWS Amplify Hosting (Deploy without Git provider).

### Configuration

After deploying both backend and frontend:

1. Open the Amplify app URL
2. On first load, the Settings screen appears
3. Configure:
   - **Amazon Cognito**: User Pool ID, User Pool Client ID, Identity Pool ID, Region
   - **AgentCore**: Agent Name, AgentCore Runtime ARN, Region
   - **Conversation History API**: API Gateway endpoint URL (from ConversationHistoryStack output)
4. Save — the app reloads with authentication enabled

## Inventory MCP Server

The Inventory MCP server provides cluster discovery and version lifecycle tracking for:

- **Amazon EKS** — Kubernetes clusters with control plane version
- **Amazon RDS / Aurora** — Database instances and clusters with engine versions
- **Amazon OpenSearch Service** — Domains with engine version
- **Amazon ElastiCache** — Redis/Valkey/Memcached clusters with engine version
- **Amazon MSK** — Kafka clusters with broker version

Each tool enriches live AWS API data with end-of-support schedules from a DynamoDB table (`aws-eol-schedules`), updated daily by a Lambda scraper. This enables queries like:

- "Which of my EKS clusters are running versions approaching end of support?"
- "List all RDS instances and their version lifecycle status"
- "Show me clusters that need version upgrades in the next 90 days"

## Prerequisites

- Node.js 18+ and npm
- Python 3.12+
- AWS CLI v2 configured with credentials
- AWS CDK v2 (`npm install -g aws-cdk`)
- Amazon Bedrock model access enabled (Claude Sonnet)

## Quick Start

```bash
# Get source files and navigate to project
cd cloudops-agent

# Deploy backend
export COGNITO_ADMIN_EMAIL="your-email@example.com"
cd cdk && npm install && npm run build
npx cdk deploy --all --require-approval never

# Build and deploy frontend
cd ../frontend && npm install && npm run build && npm run zip
# Upload cloudops-frontend.zip to AWS Amplify Hosting

# Sign in with admin + temporary password from email
# Configure settings with stack outputs
```

## Sample Queries

| Query                                                 | Category   |
| ----------------------------------------------------- | ---------- |
| "What are my AWS costs for this month?"               | Cost       |
| "What cost savings opportunities do I have?"          | Cost       |
| "Are there any alarms in ALARM state?"                | Monitoring |
| "Who modified the S3 bucket policy yesterday?"        | Audit      |
| "List all my EKS clusters and their version status"   | Inventory  |
| "Which RDS instances are approaching end of support?" | Inventory  |

## Cleanup

```bash
cd cdk
npx cdk destroy --all
```

This removes all CDK stacks including DynamoDB tables (EOL schedules and conversation history), API Gateway, Lambda functions, AgentCore runtimes, and Cognito resources.

Then delete the Frontend UI running on Amplify Hosting:

1. Go to **AWS Amplify** → select your app
2. Click **Actions** → **Delete app**

## Author

- **Nipon Maluengnont** — Technical Account Manager, AWS Enterprise Support
