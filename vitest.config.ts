import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

function source(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "@ssrl/core": source("./packages/core/src/index.ts"),
      "@ssrl/state-store": source("./packages/state-store/src/index.ts"),
      "@ssrl/materializer": source("./packages/materializer/src/index.ts"),
      "@ssrl/ingestion": source("./packages/ingestion/src/index.ts"),
      "@ssrl/journal": source("./packages/journal/src/index.ts"),
      "@ssrl/runtime": source("./packages/runtime/src/index.ts"),
      "@ssrl/runtime-host": source("./packages/runtime-host/src/index.ts"),
      "@ssrl/context": source("./packages/context/src/index.ts"),
      "@ssrl/connector-sdk": source("./packages/connector-sdk/src/index.ts"),
      "@ssrl/connector-markdown-fs": source("./packages/connector-markdown-fs/src/index.ts"),
      "@ssrl/storage-sqlite": source("./packages/storage-sqlite/src/index.ts"),
      "@ssrl/mcp-server": source("./packages/mcp-server/src/index.ts"),
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
