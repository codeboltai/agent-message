import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { AgentMessageConfig, LoadedConfig } from "./types.js";

const HandleSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  address: z.string().min(1),
  accountId: z.string().optional(),
  label: z.string().optional(),
  primary: z.boolean().optional(),
  verified: z.boolean().optional(),
  capabilities: z.array(z.string()).optional(),
});

const ConfigSchema = z.object({
  defaultAgent: z.string().optional(),
  state: z.object({ dir: z.string().optional() }).optional(),
  agents: z.record(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().optional(),
    }),
  ).default({}),
  providers: z.record(
    z.object({
      id: z.string().min(1),
      type: z.string().min(1),
      kind: z.enum(["local", "federation", "email", "social", "custom"]).optional(),
      settings: z.record(z.unknown()).optional(),
      auth: z.record(z.unknown()).optional(),
    }),
  ).default({}),
  accounts: z.record(
    z.object({
      id: z.string().min(1),
      provider: z.string().min(1),
      address: z.string().min(1),
      displayName: z.string().optional(),
      agents: z.array(z.string()).optional(),
      settings: z.record(z.unknown()).optional(),
      auth: z.record(z.unknown()).optional(),
    }),
  ).default({}),
  contacts: z.record(
    z.object({
      id: z.string().min(1),
      displayName: z.string().min(1),
      handles: z.array(HandleSchema).default([]),
      metadata: z.record(z.unknown()).optional(),
    }),
  ).default({}),
});

export function defaultConfigPath(): string {
  return join(homedir(), ".config", "agent-message", "config.yaml");
}

export function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "agent-message");
}

export function resolveConfigPath(explicitPath?: string): string {
  if (explicitPath) return resolve(explicitPath);
  if (process.env.AGENT_MESSAGE_CONFIG) {
    return resolve(process.env.AGENT_MESSAGE_CONFIG);
  }

  const projectConfig = resolve(process.cwd(), "agent-message.yaml");
  if (existsSync(projectConfig)) return projectConfig;

  return defaultConfigPath();
}

export function resolveStateDir(config: AgentMessageConfig): string {
  if (process.env.AGENT_MESSAGE_STATE_DIR) {
    return resolve(process.env.AGENT_MESSAGE_STATE_DIR);
  }
  if (config.state?.dir) return resolve(config.state.dir);
  return defaultStateDir();
}

export async function loadConfig(explicitPath?: string): Promise<LoadedConfig> {
  const path = resolveConfigPath(explicitPath);
  const raw = existsSync(path) ? await readFile(path, "utf8") : "";
  const parsed = raw.trim().length > 0 ? YAML.parse(raw) : {};
  const config = ConfigSchema.parse(parsed) as AgentMessageConfig;
  return { path, config, stateDir: resolveStateDir(config) };
}

export function validateConfig(config: unknown): AgentMessageConfig {
  return ConfigSchema.parse(config) as AgentMessageConfig;
}

export function createDefaultConfig(): AgentMessageConfig {
  return {
    defaultAgent: "default",
    state: {},
    agents: {
      default: {
        id: "default",
        name: "Default Agent",
      },
    },
    providers: {
      local: {
        id: "local",
        type: "local",
        kind: "local",
      },
    },
    accounts: {
      "default-local": {
        id: "default-local",
        provider: "local",
        address: "local:default",
        displayName: "Default Agent",
        agents: ["default"],
      },
    },
    contacts: {},
  };
}

export async function writeConfig(path: string, config: AgentMessageConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${YAML.stringify(config)}\n`, "utf8");
}
