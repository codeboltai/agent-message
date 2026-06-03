import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node20",
  splitting: false,
  clean: true,
  noExternal: [
    "@codebolt/agent-message-cli",
    "@codebolt/agent-message-core",
    "@codebolt/agent-message-federation-server",
    "@codebolt/agent-message-provider-agmail",
    "@codebolt/agent-message-provider-agentmail",
    "@codebolt/agent-message-provider-federation",
    "@codebolt/agent-message-provider-local",
    "@codebolt/agent-message-provider-lumbox",
    "@codebolt/agent-message-provider-nuntly",
    "@codebolt/agent-message-provider-openmail",
    "@codebolt/agent-message-provider-robotomail",
  ],
  outExtension() {
    return { js: ".cjs" };
  },
});
