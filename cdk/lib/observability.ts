import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/** Native service spans only: APPLICATION_LOGS can contain tokens and tool bodies. */
export function addTracing(scope: Construct, resources: Record<string, string>): void {
  const destination = new logs.CfnDeliveryDestination(scope, 'TraceDestination', {
    name: `${cdk.Stack.of(scope).stackName}-traces`,
    deliveryDestinationType: 'XRAY',
  });
  let previousDelivery: logs.CfnDelivery | undefined;
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
    if (previousDelivery) delivery.addDependency(previousDelivery);
    previousDelivery = delivery;
  }
}

/** AgentCore names a hosted runtime/Gateway workload identity after its resource ID. */
export function workloadIdentityArn(scope: Construct, resourceArn: string): string {
  return cdk.Stack.of(scope).formatArn({
    service: 'bedrock-agentcore',
    resource: 'workload-identity-directory',
    resourceName: `default/workload-identity/${cdk.Fn.select(1, cdk.Fn.split('/', resourceArn))}`,
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
}
