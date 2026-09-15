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
    let previousDelivery;
    for (const [id, arn] of Object.entries(resources)) {
        const source = new logs.CfnDeliverySource(scope, `${id}TraceSource`, {
            name: `${cdk.Stack.of(scope).stackName}-${id}-traces`,
            resourceArn: arn,
            logType: 'TRACES',
        });
        const delivery = new logs.CfnDelivery(scope, `${id}TraceDelivery`, {
            deliverySourceName: source.ref,
            deliveryDestinationArn: destination.attrArn,
        });
        // CloudWatch updates shared delivery state; concurrent creates can fail NotStabilized.
        if (previousDelivery)
            delivery.addDependency(previousDelivery);
        previousDelivery = delivery;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib2JzZXJ2YWJpbGl0eS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm9ic2VydmFiaWxpdHkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFLQSxnQ0FvQkM7QUFHRCxrREFPQztBQW5DRCxpREFBbUM7QUFDbkMsMkRBQTZDO0FBRzdDLHNGQUFzRjtBQUN0RixTQUFnQixVQUFVLENBQUMsS0FBZ0IsRUFBRSxTQUFpQztJQUM1RSxNQUFNLFdBQVcsR0FBRyxJQUFJLElBQUksQ0FBQyxzQkFBc0IsQ0FBQyxLQUFLLEVBQUUsa0JBQWtCLEVBQUU7UUFDN0UsSUFBSSxFQUFFLEdBQUcsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsU0FBUyxTQUFTO1FBQy9DLHVCQUF1QixFQUFFLE1BQU07S0FDaEMsQ0FBQyxDQUFDO0lBQ0gsSUFBSSxnQkFBOEMsQ0FBQztJQUNuRCxLQUFLLE1BQU0sQ0FBQyxFQUFFLEVBQUUsR0FBRyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDO1FBQ2xELE1BQU0sTUFBTSxHQUFHLElBQUksSUFBSSxDQUFDLGlCQUFpQixDQUFDLEtBQUssRUFBRSxHQUFHLEVBQUUsYUFBYSxFQUFFO1lBQ25FLElBQUksRUFBRSxHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDLFNBQVMsSUFBSSxFQUFFLFNBQVM7WUFDckQsV0FBVyxFQUFFLEdBQUc7WUFDaEIsT0FBTyxFQUFFLFFBQVE7U0FDbEIsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxRQUFRLEdBQUcsSUFBSSxJQUFJLENBQUMsV0FBVyxDQUFDLEtBQUssRUFBRSxHQUFHLEVBQUUsZUFBZSxFQUFFO1lBQ2pFLGtCQUFrQixFQUFFLE1BQU0sQ0FBQyxHQUFHO1lBQzlCLHNCQUFzQixFQUFFLFdBQVcsQ0FBQyxPQUFPO1NBQzVDLENBQUMsQ0FBQztRQUNILHVGQUF1RjtRQUN2RixJQUFJLGdCQUFnQjtZQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztRQUMvRCxnQkFBZ0IsR0FBRyxRQUFRLENBQUM7SUFDOUIsQ0FBQztBQUNILENBQUM7QUFFRCx3RkFBd0Y7QUFDeEYsU0FBZ0IsbUJBQW1CLENBQUMsS0FBZ0IsRUFBRSxXQUFtQjtJQUN2RSxPQUFPLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDLFNBQVMsQ0FBQztRQUNuQyxPQUFPLEVBQUUsbUJBQW1CO1FBQzVCLFFBQVEsRUFBRSw2QkFBNkI7UUFDdkMsWUFBWSxFQUFFLDZCQUE2QixHQUFHLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFLFdBQVcsQ0FBQyxDQUFDLEVBQUU7UUFDN0YsU0FBUyxFQUFFLEdBQUcsQ0FBQyxTQUFTLENBQUMsbUJBQW1CO0tBQzdDLENBQUMsQ0FBQztBQUNMLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcblxuLyoqIE5hdGl2ZSBzZXJ2aWNlIHNwYW5zIG9ubHk6IEFQUExJQ0FUSU9OX0xPR1MgY2FuIGNvbnRhaW4gdG9rZW5zIGFuZCB0b29sIGJvZGllcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhZGRUcmFjaW5nKHNjb3BlOiBDb25zdHJ1Y3QsIHJlc291cmNlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPik6IHZvaWQge1xuICBjb25zdCBkZXN0aW5hdGlvbiA9IG5ldyBsb2dzLkNmbkRlbGl2ZXJ5RGVzdGluYXRpb24oc2NvcGUsICdUcmFjZURlc3RpbmF0aW9uJywge1xuICAgIG5hbWU6IGAke2Nkay5TdGFjay5vZihzY29wZSkuc3RhY2tOYW1lfS10cmFjZXNgLFxuICAgIGRlbGl2ZXJ5RGVzdGluYXRpb25UeXBlOiAnWFJBWScsXG4gIH0pO1xuICBsZXQgcHJldmlvdXNEZWxpdmVyeTogbG9ncy5DZm5EZWxpdmVyeSB8IHVuZGVmaW5lZDtcbiAgZm9yIChjb25zdCBbaWQsIGFybl0gb2YgT2JqZWN0LmVudHJpZXMocmVzb3VyY2VzKSkge1xuICAgIGNvbnN0IHNvdXJjZSA9IG5ldyBsb2dzLkNmbkRlbGl2ZXJ5U291cmNlKHNjb3BlLCBgJHtpZH1UcmFjZVNvdXJjZWAsIHtcbiAgICAgIG5hbWU6IGAke2Nkay5TdGFjay5vZihzY29wZSkuc3RhY2tOYW1lfS0ke2lkfS10cmFjZXNgLFxuICAgICAgcmVzb3VyY2VBcm46IGFybixcbiAgICAgIGxvZ1R5cGU6ICdUUkFDRVMnLFxuICAgIH0pO1xuICAgIGNvbnN0IGRlbGl2ZXJ5ID0gbmV3IGxvZ3MuQ2ZuRGVsaXZlcnkoc2NvcGUsIGAke2lkfVRyYWNlRGVsaXZlcnlgLCB7XG4gICAgICBkZWxpdmVyeVNvdXJjZU5hbWU6IHNvdXJjZS5yZWYsXG4gICAgICBkZWxpdmVyeURlc3RpbmF0aW9uQXJuOiBkZXN0aW5hdGlvbi5hdHRyQXJuLFxuICAgIH0pO1xuICAgIC8vIENsb3VkV2F0Y2ggdXBkYXRlcyBzaGFyZWQgZGVsaXZlcnkgc3RhdGU7IGNvbmN1cnJlbnQgY3JlYXRlcyBjYW4gZmFpbCBOb3RTdGFiaWxpemVkLlxuICAgIGlmIChwcmV2aW91c0RlbGl2ZXJ5KSBkZWxpdmVyeS5hZGREZXBlbmRlbmN5KHByZXZpb3VzRGVsaXZlcnkpO1xuICAgIHByZXZpb3VzRGVsaXZlcnkgPSBkZWxpdmVyeTtcbiAgfVxufVxuXG4vKiogQWdlbnRDb3JlIG5hbWVzIGEgaG9zdGVkIHJ1bnRpbWUvR2F0ZXdheSB3b3JrbG9hZCBpZGVudGl0eSBhZnRlciBpdHMgcmVzb3VyY2UgSUQuICovXG5leHBvcnQgZnVuY3Rpb24gd29ya2xvYWRJZGVudGl0eUFybihzY29wZTogQ29uc3RydWN0LCByZXNvdXJjZUFybjogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGNkay5TdGFjay5vZihzY29wZSkuZm9ybWF0QXJuKHtcbiAgICBzZXJ2aWNlOiAnYmVkcm9jay1hZ2VudGNvcmUnLFxuICAgIHJlc291cmNlOiAnd29ya2xvYWQtaWRlbnRpdHktZGlyZWN0b3J5JyxcbiAgICByZXNvdXJjZU5hbWU6IGBkZWZhdWx0L3dvcmtsb2FkLWlkZW50aXR5LyR7Y2RrLkZuLnNlbGVjdCgxLCBjZGsuRm4uc3BsaXQoJy8nLCByZXNvdXJjZUFybikpfWAsXG4gICAgYXJuRm9ybWF0OiBjZGsuQXJuRm9ybWF0LlNMQVNIX1JFU09VUkNFX05BTUUsXG4gIH0pO1xufVxuIl19