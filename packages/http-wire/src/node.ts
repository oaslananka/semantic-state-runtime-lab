import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export interface FetchHttpHandler {
  fetch(request: Request): Promise<Response>;
}

export interface NodeFetchHttpServerOptions {
  readonly handler: FetchHttpHandler;
  readonly hostname?: string;
  readonly port?: number;
  readonly adapterFailureBody?: string;
}

export interface NodeFetchHttpServer {
  readonly server: Server;
  readonly baseUrl: URL;
  close(): Promise<void>;
}

type DuplexRequestInit = RequestInit & { readonly duplex: "half" };

function requestHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => result.append(key, item));
    else result.set(key, value);
  }
  return result;
}

async function writeResponse(
  response: Response,
  outgoing: import("node:http").ServerResponse,
): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => outgoing.setHeader(key, value));
  if (response.body === null) {
    outgoing.end();
    return;
  }
  const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  try {
    for await (const chunk of stream) {
      if (!outgoing.write(chunk)) {
        await new Promise<void>((resolve) => outgoing.once("drain", resolve));
      }
    }
    outgoing.end();
  } catch (cause) {
    outgoing.destroy(cause instanceof Error ? cause : undefined);
  }
}

export async function startNodeFetchHttpServer(
  options: NodeFetchHttpServerOptions,
): Promise<NodeFetchHttpServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const server = createServer(async (incoming, outgoing) => {
    const host = incoming.headers.host ?? hostname;
    const method = incoming.method ?? "GET";
    const init: DuplexRequestInit = {
      method,
      headers: requestHeaders(incoming.headers),
      duplex: "half",
      ...(method === "GET" || method === "HEAD"
        ? {}
        : { body: Readable.toWeb(incoming) as unknown as BodyInit }),
    };
    try {
      const request = new Request(`http://${host}${incoming.url ?? "/"}`, init);
      await writeResponse(await options.handler.fetch(request), outgoing);
    } catch {
      if (!outgoing.headersSent) {
        outgoing.statusCode = 500;
        outgoing.setHeader("content-type", "text/plain; charset=utf-8");
      }
      outgoing.end(options.adapterFailureBody ?? "HTTP node adapter failure");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, hostname, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("HTTP server did not expose a TCP address");
  }
  const tcp = address as AddressInfo;
  return {
    server,
    baseUrl: new URL(`http://${hostname}:${tcp.port}`),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
}
