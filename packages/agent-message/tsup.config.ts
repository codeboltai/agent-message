import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node20",
  dts: true,
  splitting: false,
  clean: true,
  noExternal: [
    "@codebolt/agent-message-cli",
    "@codebolt/agent-message-core",
    "@codebolt/agent-message-federation-server",
    "@codebolt/agent-message-provider-federation",
    "@codebolt/agent-message-provider-local",
  ],
  outExtension() {
    return { js: ".cjs" };
  },
});
