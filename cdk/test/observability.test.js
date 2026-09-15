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
const cdk = __importStar(require("aws-cdk-lib"));
const ecr = __importStar(require("aws-cdk-lib/aws-ecr"));
const assertions_1 = require("aws-cdk-lib/assertions");
const agent_runtime_stack_1 = require("../lib/agent-runtime-stack");
const gateway_stack_1 = require("../lib/gateway-stack");
const env = { account: '123456789012', region: 'us-east-1' };
test('main runtime exports metadata-only traces and enables native runtime/identity tracing', () => {
    const app = new cdk.App();
    const images = new cdk.Stack(app, 'Images', { env });
    const stack = new agent_runtime_stack_1.AgentRuntimeStack(app, 'TestRuntime', {
        env, repository: new ecr.Repository(images, 'Agent'),
        userPoolArn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/test',
        gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/test',
        foundationModelId: 'test-model', userPoolId: 'test',
        userPoolClientId: 'test', identityPoolId: 'test',
    });
    const template = assertions_1.Template.fromStack(stack);
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
        EnvironmentVariables: assertions_1.Match.objectLike({
            DISABLE_ADOT_OBSERVABILITY: 'true',
            OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false',
            UNIFIED_TRACES_DESTINATION_ENABLED: 'false',
        }),
    });
    template.resourceCountIs('AWS::Logs::DeliverySource', 3);
    for (const resource of Object.values(template.findResources('AWS::Logs::DeliverySource'))) {
        expect(resource.Properties.LogType).toBe('TRACES');
    }
    template.resourceCountIs('AWS::Logs::Delivery', 3);
    template.hasResourceProperties('AWS::Logs::DeliveryDestination', { DeliveryDestinationType: 'XRAY' });
});
test('Gateway, Identity and all MCP runtimes get native spans, never payload-bearing application logs', () => {
    const app = new cdk.App();
    const stack = new gateway_stack_1.AgentCoreGatewayStack(app, 'TestGatewayTracing', {
        env,
        ...Object.fromEntries(['billing', 'pricing', 'cloudwatch', 'cloudtrail', 'inventory'].flatMap(name => [
            [`${name}McpRuntimeArn`, `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${name}`],
            [`${name}McpRuntimeEndpoint`, `https://${name}.example.com/mcp`],
        ])),
        authUserPoolId: 'test', authUserPoolArn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/test',
        authM2mClientId: 'm2m', authUserPoolClientId: 'frontend',
    });
    const template = assertions_1.Template.fromStack(stack);
    template.resourceCountIs('AWS::Logs::DeliverySource', 13);
    template.resourceCountIs('AWS::Logs::Delivery', 13);
    const deliveries = Object.entries(template.findResources('AWS::Logs::Delivery'));
    for (let i = 1; i < deliveries.length; i++) {
        expect(deliveries[i][1].DependsOn).toContain(deliveries[i - 1][0]);
    }
    for (const resource of Object.values(template.findResources('AWS::Logs::DeliverySource'))) {
        expect(resource.Properties.LogType).toBe('TRACES');
    }
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
        PolicyEngineConfiguration: assertions_1.Match.objectLike({ Mode: 'ENFORCE' }),
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib2JzZXJ2YWJpbGl0eS50ZXN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsib2JzZXJ2YWJpbGl0eS50ZXN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBQ25DLHlEQUEyQztBQUMzQyx1REFBeUQ7QUFDekQsb0VBQStEO0FBQy9ELHdEQUE2RDtBQUU3RCxNQUFNLEdBQUcsR0FBRyxFQUFFLE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSxFQUFFLFdBQVcsRUFBRSxDQUFDO0FBRTdELElBQUksQ0FBQyx1RkFBdUYsRUFBRSxHQUFHLEVBQUU7SUFDakcsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7SUFDMUIsTUFBTSxNQUFNLEdBQUcsSUFBSSxHQUFHLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxRQUFRLEVBQUUsRUFBRSxHQUFHLEVBQUUsQ0FBQyxDQUFDO0lBQ3JELE1BQU0sS0FBSyxHQUFHLElBQUksdUNBQWlCLENBQUMsR0FBRyxFQUFFLGFBQWEsRUFBRTtRQUN0RCxHQUFHLEVBQUUsVUFBVSxFQUFFLElBQUksR0FBRyxDQUFDLFVBQVUsQ0FBQyxNQUFNLEVBQUUsT0FBTyxDQUFDO1FBQ3BELFdBQVcsRUFBRSwwREFBMEQ7UUFDdkUsVUFBVSxFQUFFLCtEQUErRDtRQUMzRSxpQkFBaUIsRUFBRSxZQUFZLEVBQUUsVUFBVSxFQUFFLE1BQU07UUFDbkQsZ0JBQWdCLEVBQUUsTUFBTSxFQUFFLGNBQWMsRUFBRSxNQUFNO0tBQ2pELENBQUMsQ0FBQztJQUNILE1BQU0sUUFBUSxHQUFHLHFCQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzNDLFFBQVEsQ0FBQyxxQkFBcUIsQ0FBQyxnQ0FBZ0MsRUFBRTtRQUMvRCxvQkFBb0IsRUFBRSxrQkFBSyxDQUFDLFVBQVUsQ0FBQztZQUNyQywwQkFBMEIsRUFBRSxN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cm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgeyBNYXRjaCwgVGVtcGxhdGUgfSBmcm9tICdhd3MtY2RrLWxpYi9hc3NlcnRpb25zJztcbmltcG9ydCB7IEFnZW50UnVudGltZVN0YWNrIH0gZnJvbSAnLi4vbGliL2FnZW50LXJ1bnRpbWUtc3RhY2snO1xuaW1wb3J0IHsgQWdlbnRDb3JlR2F0ZXdheVN0YWNrIH0gZnJvbSAnLi4vbGliL2dhdGV3YXktc3RhY2snO1xuXG5jb25zdCBlbnYgPSB7IGFjY291bnQ6ICcxMjM0NTY3ODkwMTInLCByZWdpb246ICd1cy1lYXN0LTEnIH07XG5cbnRlc3QoJ21haW4gcnVudGltZSBleHBvcnRzIG1ldGFkYXRhLW9ubHkgdHJhY2VzIGFuZCBlbmFibGVzIG5hdGl2ZSBydW50aW1lL2lkZW50aXR5IHRyYWNpbmcnLCAoKSA9PiB7XG4gIGNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gIGNvbnN0IGltYWdlcyA9IG5ldyBjZGsuU3RhY2soYXBwLCAnSW1hZ2VzJywgeyBlbnYgfSk7XG4gIGNvbnN0IHN0YWNrID0gbmV3IEFnZW50UnVudGltZVN0YWNrKGFwcCwgJ1Rlc3RSdW50aW1lJywge1xuICAgIGVudiwgcmVwb3NpdG9yeTogbmV3IGVjci5SZXBvc2l0b3J5KGltYWdlcywgJ0FnZW50JyksXG4gICAgdXNlclBvb2xBcm46ICdhcm46YXdzOmNvZ25pdG8taWRwOnVzLWVhc3QtMToxMjM0NTY3ODkwMTI6dXNlcnBvb2wvdGVzdCcsXG4gICAgZ2F0ZXdheUFybjogJ2Fybjphd3M6YmVkcm9jay1hZ2VudGNvcmU6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjpnYXRld2F5L3Rlc3QnLFxuICAgIGZvdW5kYXRpb25Nb2RlbElkOiAndGVzdC1tb2RlbCcsIHVzZXJQb29sSWQ6ICd0ZXN0JyxcbiAgICB1c2VyUG9vbENsaWVudElkOiAndGVzdCcsIGlkZW50aXR5UG9vbElkOiAndGVzdCcsXG4gIH0pO1xuICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjayk7XG4gIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpCZWRyb2NrQWdlbnRDb3JlOjpSdW50aW1lJywge1xuICAgIEVudmlyb25tZW50VmFyaWFibGVzOiBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgIERJU0FCTEVfQURPVF9PQlNFUlZBQklMSVRZOiAndHJ1ZScsXG4gICAgICBPVEVMX0lOU1RSVU1FTlRBVElPTl9HRU5BSV9DQVBUVVJFX01FU1NBR0VfQ09OVEVOVDogJ2ZhbHNlJyxcbiAgICAgIFVOSUZJRURfVFJBQ0VTX0RFU1RJTkFUSU9OX0VOQUJMRUQ6ICdmYWxzZScsXG4gICAgfSksXG4gIH0pO1xuICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6TG9nczo6RGVsaXZlcnlTb3VyY2UnLCAzKTtcbiAgZm9yIChjb25zdCByZXNvdXJjZSBvZiBPYmplY3QudmFsdWVzKHRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoJ0FXUzo6TG9nczo6RGVsaXZlcnlTb3VyY2UnKSkpIHtcbiAgICBleHBlY3QocmVzb3VyY2UuUHJvcGVydGllcy5Mb2dUeXBlKS50b0JlKCdUUkFDRVMnKTtcbiAgfVxuICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6TG9nczo6RGVsaXZlcnknLCAzKTtcbiAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkxvZ3M6OkRlbGl2ZXJ5RGVzdGluYXRpb24nLCB7IERlbGl2ZXJ5RGVzdGluYXRpb25UeXBlOiAnWFJBWScgfSk7XG59KTtcblxudGVzdCgnR2F0ZXdheSwgSWRlbnRpdHkgYW5kIGFsbCBNQ1AgcnVudGltZXMgZ2V0IG5hdGl2ZSBzcGFucywgbmV2ZXIgcGF5bG9hZC1iZWFyaW5nIGFwcGxpY2F0aW9uIGxvZ3MnLCAoKSA9PiB7XG4gIGNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG4gIGNvbnN0IHN0YWNrID0gbmV3IEFnZW50Q29yZUdhdGV3YXlTdGFjayhhcHAsICdUZXN0R2F0ZXdheVRyYWNpbmcnLCB7XG4gICAgZW52LFxuICAgIC4uLk9iamVjdC5mcm9tRW50cmllcyhbJ2JpbGxpbmcnLCAncHJpY2luZycsICdjbG91ZHdhdGNoJywgJ2Nsb3VkdHJhaWwnLCAnaW52ZW50b3J5J10uZmxhdE1hcChuYW1lID0+IFtcbiAgICAgIFtgJHtuYW1lfU1jcFJ1bnRpbWVBcm5gLCBgYXJuOmF3czpiZWRyb2NrLWFnZW50Y29yZTp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOnJ1bnRpbWUvJHtuYW1lfWBdLFxuICAgICAgW2Ake25hbWV9TWNwUnVudGltZUVuZHBvaW50YCwgYGh0dHBzOi8vJHtuYW1lfS5leGFtcGxlLmNvbS9tY3BgXSxcbiAgICBdKSkgYXMgYW55LFxuICAgIGF1dGhVc2VyUG9vbElkOiAndGVzdCcsIGF1dGhVc2VyUG9vbEFybjogJ2Fybjphd3M6Y29nbml0by1pZHA6dXMtZWFzdC0xOjEyMzQ1Njc4OTAxMjp1c2VycG9vbC90ZXN0JyxcbiAgICBhdXRoTTJtQ2xpZW50SWQ6ICdtMm0nLCBhdXRoVXNlclBvb2xDbGllbnRJZDogJ2Zyb250ZW5kJyxcbiAgfSk7XG4gIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKTtcbiAgdGVtcGxhdGUucmVzb3VyY2VDb3VudElzKCdBV1M6OkxvZ3M6OkRlbGl2ZXJ5U291cmNlJywgMTMpO1xuICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoJ0FXUzo6TG9nczo6RGVsaXZlcnknLCAxMyk7XG4gIGNvbnN0IGRlbGl2ZXJpZXMgPSBPYmplY3QuZW50cmllcyh0ZW1wbGF0ZS5maW5kUmVzb3VyY2VzKCdBV1M6OkxvZ3M6OkRlbGl2ZXJ5JykpO1xuICBmb3IgKGxldCBpID0gMTsgaSA8IGRlbGl2ZXJpZXMubGVuZ3RoOyBpKyspIHtcbiAgICBleHBlY3QoZGVsaXZlcmllc1tpXVsxXS5EZXBlbmRzT24pLnRvQ29udGFpbihkZWxpdmVyaWVzW2kgLSAxXVswXSk7XG4gIH1cbiAgZm9yIChjb25zdCByZXNvdXJjZSBvZiBPYmplY3QudmFsdWVzKHRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoJ0FXUzo6TG9nczo6RGVsaXZlcnlTb3VyY2UnKSkpIHtcbiAgICBleHBlY3QocmVzb3VyY2UuUHJvcGVydGllcy5Mb2dUeXBlKS50b0JlKCdUUkFDRVMnKTtcbiAgfVxuICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QmVkcm9ja0FnZW50Q29yZTo6R2F0ZXdheScsIHtcbiAgICBQb2xpY3lFbmdpbmVDb25maWd1cmF0aW9uOiBNYXRjaC5vYmplY3RMaWtlKHsgTW9kZTogJ0VORk9SQ0UnIH0pLFxuICB9KTtcbn0pO1xuIl19