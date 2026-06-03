import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@codebolt/agent-message-core": new URL(
        "./packages/core/src/index.ts",
        import.meta.url,
      ).pathname,
      "@codebolt/agent-message-provider-local": new URL(
        "./packages/provider-local/src/index.ts",
        import.meta.url,
      ).pathname,
      "@codebolt/agent-message-provider-federation": new URL(
        "./packages/provider-federation/src/index.ts",
        import.meta.url,
      ).pathname,
      "@codebolt/agent-message-cli": new URL(
        "./packages/cli/src/index.ts",
        import.meta.url,
      ).pathname,
      "@codebolt/agent-message-federation-server": new URL(
        "./packages/federation-server/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
