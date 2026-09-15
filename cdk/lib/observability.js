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
exports.addTracing = addTracing;
exports.workloadIdentityArn = workloadIdentityArn;
const cdk = __importStar(require("aws-cdk-lib"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
/** Native service spans only: APPLICATION_LOGS can contain tokens and tool bodies. */
function addTracing(scope, resources) {
    const destination = new logs.CfnDeliveryDestination(scope, 'TraceDestination', {
        name: `${cdk.Stack.of(scope).stackName}-traces`,
        deliveryDestinationType: 'XRAY',
    });
    for (const [id, arn] of Object.entries(resources)) {
        const source = new logs.CfnDeliverySource(scope, `${id}TraceSource`, {
            name: `${cdk.Stack.of(scope).stackName}-${id}-traces`,
            resourceArn: arn,
            logType: 'TRACES',
        });
        new logs.CfnDelivery(scope, `${id}TraceDelivery`, {
            deliverySourceName: source.ref,
            deliveryDestinationArn: destination.attrArn,
        });
    }
}
/** AgentCore names a hosted runtime/Gateway workload identity after its resource ID. */
function workloadIdentityArn(scope, resourceArn) {
    return cdk.Stack.of(scope).formatArn({
        service: 'bedrock-agentcore',
        resource: 'workload-identity-directory',
        resourceName: `default/workload-identity/${cdk.Fn.select(1, cdk.Fn.split('/', resourceArn))}`,
        arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib2JzZXJ2YWJpbGl0eS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm9ic2VydmFiaWxpdHkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFLQSxnQ0FnQkM7QUFHRCxrREFPQztBQS9CRCxpREFBbUM7QUFDbkMsMkRBQTZDO0FBRzdDLHNGQUFzRjtBQUN0RixTQUFnQixVQUFVLENBQUMsS0FBZ0IsRUFBRSxTQUFpQztJQUM1RSxNQUFNLFdBQVcsR0FBRyxJQUFJLElBQUksQ0FBQyxzQkFBc0IsQ0FBQyxLQUFLLEVBQUUsa0JBQWtCLEVBQUU7UUFDN0UsSUFBSSxFQUFFLEdBQUcsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsU0FBUyxTQUFTO1FBQy9DLHVCQUF1QixFQUFFLE1BQU07S0FDaEMsQ0FBQyxDQUFDO0lBQ0gsS0FBSyxNQUFNLENBQUMsRUFBRSxFQUFFLEdBQUcsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQztRQUNsRCxNQUFNLE1BQU0sR0FBRyxJQUFJLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxLQUFLLEVBQUUsR0FBRyxFQUFFLGFBQWEsRUFBRTtZQUNuRSxJQUFJLEVBQUUsR0FBRyxHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxTQUFTLElBQUksRUFBRSxTQUFTO1lBQ3JELFdBQVcsRUFBRSxHQUFHO1lBQ2hCLE9BQU8sRUFBRSxRQUFRO1NBQ2xCLENBQUMsQ0FBQztRQUNILElBQUksSUFBSSxDQUFDLFdBQVcsQ0FBQyxLQUFLLEVBQUUsR0FBRyxFQUFFLGVBQWUsRUFBRTtZQUNoRCxrQkFBa0IsRUFBRSxNQUFNLENBQUMsR0FBRztZQUM5QixzQkFBc0IsRUFBRSxXQUFXLENBQUMsT0FBTztTQUM1QyxDQUFDLENBQUM7SUFDTCxDQUFDO0FBQ0gsQ0FBQztBQUVELHdGQUF3RjtBQUN4RixTQUFnQixtQkFBbUIsQ0FBQyxLQUFnQixFQUFFLFdBQW1CO0lBQ3ZFLE9BQU8sR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsU0FBUyxDQUFDO1FBQ25DLE9BQU8sRUFBRSxtQkFBbUI7UUFDNUIsUUFBUSxFQUFFLDZCQUE2QjtRQUN2QyxZQUFZLEVBQUUsNkJBQTZCLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsV0FBVyxDQUFDLENBQUMsRUFBRTtRQUM3RixTQUFTLEVBQUUsR0FBRyxDQUFDLFNBQVMsQ0FBQyxtQkFBbUI7S0FDN0MsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuXG4vKiogTmF0aXZlIHNlcnZpY2Ugc3BhbnMgb25seTogQVBQTElDQVRJT05fTE9HUyBjYW4gY29udGFpbiB0b2tlbnMgYW5kIHRvb2wgYm9kaWVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFkZFRyYWNpbmcoc2NvcGU6IENvbnN0cnVjdCwgcmVzb3VyY2VzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KTogdm9pZCB7XG4gIGNvbnN0IGRlc3RpbmF0aW9uID0gbmV3IGxvZ3MuQ2ZuRGVsaXZlcnlEZXN0aW5hdGlvbihzY29wZSwgJ1RyYWNlRGVzdGluYXRpb24nLCB7XG4gICAgbmFtZTogYCR7Y2RrLlN0YWNrLm9mKHNjb3BlKS5zdGFja05hbWV9LXRyYWNlc2AsXG4gICAgZGVsaXZlcnlEZXN0aW5hdGlvblR5cGU6ICdYUkFZJyxcbiAgfSk7XG4gIGZvciAoY29uc3QgW2lkLCBhcm5dIG9mIE9iamVjdC5lbnRyaWVzKHJlc291cmNlcykpIHtcbiAgICBjb25zdCBzb3VyY2UgPSBuZXcgbG9ncy5DZm5EZWxpdmVyeVNvdXJjZShzY29wZSwgYCR7aWR9VHJhY2VTb3VyY2VgLCB7XG4gICAgICBuYW1lOiBgJHtjZGsuU3RhY2sub2Yoc2NvcGUpLnN0YWNrTmFtZX0tJHtpZH0tdHJhY2VzYCxcbiAgICAgIHJlc291cmNlQXJuOiBhcm4sXG4gICAgICBsb2dUeXBlOiAnVFJBQ0VTJyxcbiAgICB9KTtcbiAgICBuZXcgbG9ncy5DZm5EZWxpdmVyeShzY29wZSwgYCR7aWR9VHJhY2VEZWxpdmVyeWAsIHtcbiAgICAgIGRlbGl2ZXJ5U291cmNlTmFtZTogc291cmNlLnJlZixcbiAgICAgIGRlbGl2ZXJ5RGVzdGluYXRpb25Bcm46IGRlc3RpbmF0aW9uLmF0dHJBcm4sXG4gICAgfSk7XG4gIH1cbn1cblxuLyoqIEFnZW50Q29yZSBuYW1lcyBhIGhvc3RlZCBydW50aW1lL0dhdGV3YXkgd29ya2xvYWQgaWRlbnRpdHkgYWZ0ZXIgaXRzIHJlc291cmNlIElELiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdvcmtsb2FkSWRlbnRpdHlBcm4oc2NvcGU6IENvbnN0cnVjdCwgcmVzb3VyY2VBcm46IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBjZGsuU3RhY2sub2Yoc2NvcGUpLmZvcm1hdEFybih7XG4gICAgc2VydmljZTogJ2JlZHJvY2stYWdlbnRjb3JlJyxcbiAgICByZXNvdXJjZTogJ3dvcmtsb2FkLWlkZW50aXR5LWRpcmVjdG9yeScsXG4gICAgcmVzb3VyY2VOYW1lOiBgZGVmYXVsdC93b3JrbG9hZC1pZGVudGl0eS8ke2Nkay5Gbi5zZWxlY3QoMSwgY2RrLkZuLnNwbGl0KCcvJywgcmVzb3VyY2VBcm4pKX1gLFxuICAgIGFybkZvcm1hdDogY2RrLkFybkZvcm1hdC5TTEFTSF9SRVNPVVJDRV9OQU1FLFxuICB9KTtcbn1cbiJdfQ==