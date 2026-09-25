import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

function source(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "@ssrl/access": source("./packages/access/src/index.ts"),
      "@ssrl/core": source("./packages/core/src/index.ts"),
      "@ssrl/device-trust": source("./packages/device-trust/src/index.ts"),
      "@ssrl/device-trust-http": source("./packages/device-trust-http/src/index.ts"),
      "@ssrl/artifact-store": source("./packages/artifact-store/src/index.ts"),
      "@ssrl/artifact-access": source("./packages/artifact-access/src/index.ts"),
      "@ssrl/storage-local-artifacts": source("./packages/storage-local-artifacts/src/index.ts"),
      "@ssrl/state-store": source("./packages/state-store/src/index.ts"),
      "@ssrl/materializer": source("./packages/materializer/src/index.ts"),
      "@ssrl/replication/merkle": source("./packages/replication/src/merkle.ts"),
      "@ssrl/replication/sync": source("./packages/replication/src/sync.ts"),
      "@ssrl/replication": source("./packages/replication/src/index.ts"),
      "@ssrl/replication-access": source("./packages/replication-access/src/index.ts"),
      "@ssrl/http-wire/node": source("./packages/http-wire/src/node.ts"),
      "@ssrl/http-wire": source("./packages/http-wire/src/index.ts"),
      "@ssrl/replication-http": source("./packages/replication-http/src/index.ts"),
      "@ssrl/ingestion": source("./packages/ingestion/src/index.ts"),
      "@ssrl/journal": source("./packages/journal/src/index.ts"),
      "@ssrl/runtime": source("./packages/runtime/src/index.ts"),
      "@ssrl/runtime-host": source("./packages/runtime-host/src/index.ts"),
      "@ssrl/context": source("./packages/context/src/index.ts"),
      "@ssrl/context-access": source("./packages/context-access/src/index.ts"),
      "@ssrl/connector-sdk": source("./packages/connector-sdk/src/index.ts"),
      "@ssrl/connector-google-calendar": source("./packages/connector-google-calendar/src/index.ts"),
      "@ssrl/connector-markdown-fs": source("./packages/connector-markdown-fs/src/index.ts"),
      "@ssrl/storage-sqlite": source("./packages/storage-sqlite/src/index.ts"),
      "@ssrl/storage-sqlite-device-trust": source("./packages/storage-sqlite-device-trust/src/index.ts"),
      "@ssrl/storage-sqlite-capsules": source("./packages/storage-sqlite-capsules/src/index.ts"),
      "@ssrl/mcp-server": source("./packages/mcp-server/src/index.ts"),
      "@ssrl/mcp-http": source("./packages/mcp-http/src/index.ts"),
      "@ssrl/node-app": source("./packages/node-app/src/index.ts"),
    },
  },
  test: {
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
    ],
  },
});
