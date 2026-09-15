import { Construct } from 'constructs';
/** Native service spans only: APPLICATION_LOGS can contain tokens and tool bodies. */
export declare function addTracing(scope: Construct, resources: Record<string, string>): void;
/** AgentCore names a hosted runtime/Gateway workload identity after its resource ID. */
export declare function workloadIdentityArn(scope: Construct, resourceArn: string): string;
