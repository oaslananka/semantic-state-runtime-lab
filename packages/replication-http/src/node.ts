import {
  startNodeFetchHttpServer,
  type NodeFetchHttpServer,
} from "@ssrl/http-wire/node";
import type { ReplicationHttpHandler } from "./server.js";

export interface NodeReplicationHttpServerOptions {
  readonly handler: ReplicationHttpHandler;
  readonly hostname?: string;
  readonly port?: number;
}

export type NodeReplicationHttpServer = NodeFetchHttpServer;

export async function startNodeReplicationHttpServer(
  options: NodeReplicationHttpServerOptions,
): Promise<NodeReplicationHttpServer> {
  return startNodeFetchHttpServer({
    handler: options.handler,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    ...(options.port === undefined ? {} : { port: options.port }),
    adapterFailureBody: "replication node adapter failure",
  });
}
