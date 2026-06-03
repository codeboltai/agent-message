import { Command } from "commander";
import {
  createDefaultConfig,
  JsonlEventStore,
  loadConfig,
  ProviderRegistry,
  resolveActiveAgent,
  resolveAccount,
  resolveConfigPath,
  resolveRecipient,
  validateConfig,
  writeConfig,
  type AgentMessageConfig,
  type LoadedConfig,
  type OutputFormat,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderConfig,
} from "@codebolt/agent-message-core";
import { localProvider } from "@codebolt/agent-message-provider-local";
import { federationProvider } from "@codebolt/agent-message-provider-federation";
import { agentMailProvider } from "@codebolt/agent-message-provider-agentmail";
import { openMailProvider } from "@codebolt/agent-message-provider-openmail";
import { robotomailProvider } from "@codebolt/agent-message-provider-robotomail";
import { nuntlyProvider } from "@codebolt/agent-message-provider-nuntly";
import { lumboxProvider } from "@codebolt/agent-message-provider-lumbox";
import { agmailProvider } from "@codebolt/agent-message-provider-agmail";
import { startFederationServer } from "@codebolt/agent-message-federation-server";

interface GlobalOptions {
  config?: string;
  agent?: string;
  account?: string;
  format?: OutputFormat;
  verbose?: boolean;
}

interface Runtime {
  loadedConfig: LoadedConfig;
  store: JsonlEventStore;
  registry: ProviderRegistry;
}

const emailProviderTypes = new Set(["agentmail", "openmail", "robotomail", "nuntly", "lumbox", "agmail"]);

function createRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(localProvider);
  registry.register(federationProvider);
  registry.register(agentMailProvider);
  registry.register(openMailProvider);
  registry.register(robotomailProvider);
  registry.register(nuntlyProvider);
  registry.register(lumboxProvider);
  registry.register(agmailProvider);
  return registry;
}

function print(value: unknown, format: OutputFormat = "pretty"): void {
  if (format === "json") {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (typeof value === "string") {
    console.log(value);
    return;
  }

  console.log(JSON.stringify(value, null, 2));
}

async function runtime(options: GlobalOptions): Promise<Runtime> {
  const loadedConfig = await loadConfig(options.config);
  return {
    loadedConfig,
    store: new JsonlEventStore(loadedConfig.stateDir),
    registry: createRegistry(),
  };
}

function providerContext(
  runtimeValue: Runtime,
  providerId: string,
): { adapter: ProviderAdapter; context: ProviderContext } {
  let providerConfig = runtimeValue.loadedConfig.config.providers[providerId];
  if (!providerConfig && providerId === "local") {
    providerConfig = { id: "local", type: "local", kind: "local" };
  }
  if (!providerConfig && providerId === "federation") {
    providerConfig = { id: "federation", type: "federation", kind: "custom" };
  }
  if (!providerConfig && providerId === "agentmail") {
    providerConfig = { id: "agentmail", type: "agentmail", kind: "email" };
  }
  if (!providerConfig && emailProviderTypes.has(providerId)) {
    providerConfig = { id: providerId, type: providerId, kind: "email" };
  }
  if (!providerConfig) throw new Error(`Provider '${providerId}' is not configured.`);

  const adapter = runtimeValue.registry.get(providerConfig.type);
  return {
    adapter,
    context: {
      loadedConfig: runtimeValue.loadedConfig,
      store: runtimeValue.store,
      providerConfig,
    },
  };
}

async function updateConfig(
  options: GlobalOptions,
  edit: (config: AgentMessageConfig) => void,
): Promise<LoadedConfig> {
  const loaded = await loadConfig(options.config);
  edit(loaded.config);
  validateConfig(loaded.config);
  await writeConfig(loaded.path, loaded.config);
  return loaded;
}

function ensureProvider(config: AgentMessageConfig, providerId: string): ProviderConfig {
  const existing = config.providers[providerId];
  if (existing) return existing;
  const provider: ProviderConfig = {
    id: providerId,
    type: providerId,
    kind: providerId === "local" ? "local" : emailProviderTypes.has(providerId) ? "email" : "custom",
  };
  config.providers[providerId] = provider;
  return provider;
}

function doctor(config: AgentMessageConfig): string[] {
  const problems: string[] = [];
  for (const [agentId, agent] of Object.entries(config.agents)) {
    if (agent.id !== agentId) problems.push(`agents.${agentId}.id should equal '${agentId}'.`);
  }
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (provider.id !== providerId) problems.push(`providers.${providerId}.id should equal '${providerId}'.`);
  }
  for (const [accountId, account] of Object.entries(config.accounts)) {
    if (account.id !== accountId) problems.push(`accounts.${accountId}.id should equal '${accountId}'.`);
    if (!config.providers[account.provider]) {
      problems.push(`accounts.${accountId}.provider references missing provider '${account.provider}'.`);
    }
    for (const agentId of account.agents ?? []) {
      if (!config.agents[agentId]) problems.push(`accounts.${accountId}.agents references missing agent '${agentId}'.`);
    }
  }
  for (const [contactId, contact] of Object.entries(config.contacts)) {
    if (contact.id !== contactId) problems.push(`contacts.${contactId}.id should equal '${contactId}'.`);
    const primaryCount = contact.handles.filter((handle) => handle.primary).length;
    if (primaryCount > 1) problems.push(`contacts.${contactId} has multiple primary handles.`);
    for (const handle of contact.handles) {
      if (!config.providers[handle.provider]) {
        problems.push(`contacts.${contactId}.handles.${handle.id} references missing provider '${handle.provider}'.`);
      }
      if (handle.accountId && !config.accounts[handle.accountId]) {
        problems.push(`contacts.${contactId}.handles.${handle.id} references missing account '${handle.accountId}'.`);
      }
    }
  }
  return problems;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("agent-message")
    .description("Central communication CLI for agents")
    .option("--config <path>", "config file path")
    .option("--agent <agent-id>", "active agent id")
    .option("--account <account-id>", "active account id")
    .option("--format <format>", "json or pretty", "pretty")
    .option("--verbose", "show verbose errors");

  const config = program.command("config").description("Manage configuration");
  config.command("init").description("Create a default config").action(async () => {
    const options = program.opts<GlobalOptions>();
    const path = resolveConfigPath(options.config);
    const configValue = createDefaultConfig();
    await writeConfig(path, configValue);
    print({ path, config: configValue }, options.format);
  });
  config.command("path").description("Print config path").action(() => {
    const options = program.opts<GlobalOptions>();
    print(resolveConfigPath(options.config), options.format);
  });
  config.command("validate").description("Validate config").action(async () => {
    const options = program.opts<GlobalOptions>();
    const loaded = await loadConfig(options.config);
    validateConfig(loaded.config);
    print({ ok: true, path: loaded.path }, options.format);
  });
  config.command("doctor").description("Validate references and provider setup").action(async () => {
    const options = program.opts<GlobalOptions>();
    const loaded = await loadConfig(options.config);
    const problems = doctor(loaded.config);
    print({ ok: problems.length === 0, problems }, options.format);
  });

  const agents = program.command("agents").description("Manage named agent identities");
  agents.command("list").action(async () => {
    const options = program.opts<GlobalOptions>();
    const loaded = await loadConfig(options.config);
    print(Object.values(loaded.config.agents), options.format);
  });
  agents.command("show <agentId>").action(async (agentId: string) => {
    const options = program.opts<GlobalOptions>();
    const loaded = await loadConfig(options.config);
    const agent = loaded.config.agents[agentId];
    if (!agent) throw new Error(`Agent '${agentId}' is not configured.`);
    print(agent, options.format);
  });
  agents.command("create <agentId>").requiredOption("--name <name>").action(
    async (agentId: string, commandOptions: { name: string }) => {
      const options = program.opts<GlobalOptions>();
      const loaded = await updateConfig(options, (configValue) => {
        configValue.agents[agentId] = { id: agentId, name: commandOptions.name };
        configValue.defaultAgent ??= agentId;
      });
      print(loaded.config.agents[agentId], options.format);
    },
  );
  agents.command("current").action(async () => {
    const options = program.opts<GlobalOptions>();
    const loaded = await loadConfig(options.config);
    const agentId = resolveActiveAgent(loaded.config, options.agent);
    print(loaded.config.agents[agentId], options.format);
  });

  const providers = program.command("providers").description("Inspect providers");
  providers.command("list").action(async () => {
    const options = program.opts<GlobalOptions>();
    const loaded = await loadConfig(options.config);
    const registry = createRegistry();
    print(
      registry.list().map((adapter) => ({
        type: adapter.type,
        kind: adapter.kind,
        configured: Object.values(loaded.config.providers).some((provider) => provider.type === adapter.type),
        capabilities: adapter.capabilities,
      })),
      options.format,
    );
  });
  providers.command("capabilities <provider>").action(async (provider: string) => {
    const options = program.opts<GlobalOptions>();
    const rt = await runtime(options);
    const { adapter } = providerContext(rt, provider);
    print({ provider, capabilities: adapter.capabilities }, options.format);
  });

  const accounts = program.command("accounts").description("Manage provider accounts");
  accounts.command("list").action(async () => {
    const options = program.opts<GlobalOptions>();
    const loaded = await loadConfig(options.config);
    print(Object.values(loaded.config.accounts), options.format);
  });
  accounts.command("show <accountId>").action(async (accountId: string) => {
    const options = program.opts<GlobalOptions>();
    const loaded = await loadConfig(options.config);
    const account = loaded.config.accounts[accountId];
    if (!account) throw new Error(`Account '${accountId}' is not configured.`);
    print(account, options.format);
  });
  accounts.command("setup <provider>").action(async (provider: string) => {
    const options = program.opts<GlobalOptions>();
    const rt = await runtime(options);
    const { adapter, context } = providerContext(rt, provider);
    print(await adapter.setup(context), options.format);
  });
  accounts.command("create <provider>")
    .option("--id <account-id>")
    .option("--name <name>")
    .option("--address <address>")
    .action(async (provider: string, commandOptions: { id?: string; name?: string; address?: string }) => {
      const options = program.opts<GlobalOptions>();
      const rt = await runtime(options);
      const agentId = resolveActiveAgent(rt.loadedConfig.config, options.agent);
      ensureProvider(rt.loadedConfig.config, provider);
      const { adapter, context } = providerContext(rt, provider);
      if (!adapter.createAccount) {
        throw new Error(`Provider '${provider}' cannot create accounts. Use accounts setup ${provider}.`);
      }
      const account = await adapter.createAccount(
        { agentId, name: commandOptions.id ?? commandOptions.name, address: commandOptions.address },
        context,
      );
      account.id = commandOptions.id ?? account.id;
      await updateConfig(options, (configValue) => {
        ensureProvider(configValue, provider);
        configValue.accounts[account.id] = account;
      });
      print(account, options.format);
    });

  const contacts = program.command("contacts").description("Manage contacts");
  contacts.command("list").action(async () => {
    const options = program.opts<GlobalOptions>();
    const loaded = await loadConfig(options.config);
    print(Object.values(loaded.config.contacts), options.format);
  });
  contacts.command("search <query>").action(async (query: string) => {
    const options = program.opts<GlobalOptions>();
    const loaded = await loadConfig(options.config);
    const normalized = query.toLowerCase();
    print(
      Object.values(loaded.config.contacts).filter((contact) => {
        return contact.id.toLowerCase().includes(normalized) ||
          contact.displayName.toLowerCase().includes(normalized) ||
          contact.handles.some((handle) => handle.address.toLowerCase().includes(normalized));
      }),
      options.format,
    );
  });
  contacts.command("show <contactId>").action(async (contactId: string) => {
    const options = program.opts<GlobalOptions>();
    const loaded = await loadConfig(options.config);
    const contact = loaded.config.contacts[contactId];
    if (!contact) throw new Error(`Contact '${contactId}' is not configured.`);
    print(contact, options.format);
  });
  contacts.command("create <contactId>").requiredOption("--name <name>").action(
    async (contactId: string, commandOptions: { name: string }) => {
      const options = program.opts<GlobalOptions>();
      const loaded = await updateConfig(options, (configValue) => {
        configValue.contacts[contactId] = {
          id: contactId,
          displayName: commandOptions.name,
          handles: [],
        };
      });
      print(loaded.config.contacts[contactId], options.format);
    },
  );
  contacts.command("add-handle <contactId>")
    .requiredOption("--provider <provider>")
    .requiredOption("--address <address>")
    .option("--account <account-id>")
    .option("--label <label>")
    .option("--handle-id <handle-id>")
    .option("--primary")
    .action(
      async (
        contactId: string,
        commandOptions: {
          provider: string;
          address: string;
          account?: string;
          label?: string;
          handleId?: string;
          primary?: boolean;
        },
      ) => {
        const options = program.opts<GlobalOptions>();
        const loaded = await updateConfig(options, (configValue) => {
          const contact = configValue.contacts[contactId];
          if (!contact) throw new Error(`Contact '${contactId}' is not configured.`);
          ensureProvider(configValue, commandOptions.provider);
          if (commandOptions.account && !configValue.accounts[commandOptions.account]) {
            throw new Error(`Account '${commandOptions.account}' is not configured.`);
          }
          if (commandOptions.primary) {
            for (const handle of contact.handles) handle.primary = false;
          }
          const handle = {
            id: commandOptions.handleId ?? `${commandOptions.provider}-${contact.handles.length + 1}`,
            provider: commandOptions.provider,
            address: commandOptions.address,
            accountId: commandOptions.account,
            label: commandOptions.label,
            primary: commandOptions.primary ?? contact.handles.length === 0,
          };
          contact.handles.push(handle);
        });
        print(loaded.config.contacts[contactId], options.format);
      },
    );

  program.command("send")
    .requiredOption("--to <contact-or-address>")
    .requiredOption("--text <text>")
    .option("--via <provider-or-handle>")
    .option("--subject <subject>")
    .action(async (commandOptions: { to: string; text: string; via?: string; subject?: string }) => {
      const options = program.opts<GlobalOptions>();
      const rt = await runtime(options);
      const agentId = resolveActiveAgent(rt.loadedConfig.config, options.agent);
      const recipient = resolveRecipient(rt.loadedConfig.config, commandOptions.to, commandOptions.via);
      const { adapter, context } = providerContext(rt, recipient.provider);
      print(
        await adapter.sendMessage(
          {
            agentId,
            accountId: options.account,
            to: commandOptions.to,
            via: commandOptions.via,
            text: commandOptions.text,
            subject: commandOptions.subject,
          },
          context,
        ),
        options.format,
      );
    });

  const mailbox = program.command("mailbox").description("Read mailbox");
  mailbox.command("list").option("--limit <number>", "max messages", "20").action(
    async (commandOptions: { limit: string }) => {
      const options = program.opts<GlobalOptions>();
      const rt = await runtime(options);
      const agentId = resolveActiveAgent(rt.loadedConfig.config, options.agent);
      const account = resolveAccount(rt.loadedConfig.config, agentId, options.account);
      const { adapter, context } = providerContext(rt, account.provider);
      print(
        await adapter.listMailbox({ agentId, accountId: account.id, limit: Number(commandOptions.limit) }, context),
        options.format,
      );
    },
  );

  const messages = program.command("messages").description("Read messages");
  messages.command("read <messageId>").action(async (messageId: string) => {
    const options = program.opts<GlobalOptions>();
    const rt = await runtime(options);
    const agentId = resolveActiveAgent(rt.loadedConfig.config, options.agent);
    const account = resolveAccount(rt.loadedConfig.config, agentId, options.account);
    const { adapter, context } = providerContext(rt, account.provider);
    const message = await adapter.readMessage(messageId, { agentId, accountId: account.id }, context);
    if (!message) throw new Error(`Message '${messageId}' was not found.`);
    print(message, options.format);
  });

  const threads = program.command("threads").description("Read and reply to threads");
  threads.command("list").option("--limit <number>", "max threads", "20").action(
    async (commandOptions: { limit: string }) => {
      const options = program.opts<GlobalOptions>();
      const rt = await runtime(options);
      const agentId = resolveActiveAgent(rt.loadedConfig.config, options.agent);
      const account = resolveAccount(rt.loadedConfig.config, agentId, options.account);
      const { adapter, context } = providerContext(rt, account.provider);
      print(
        await adapter.listThreads({ agentId, accountId: account.id, limit: Number(commandOptions.limit) }, context),
        options.format,
      );
    },
  );
  threads.command("read <threadId>").action(async (threadId: string) => {
    const options = program.opts<GlobalOptions>();
    const rt = await runtime(options);
    const agentId = resolveActiveAgent(rt.loadedConfig.config, options.agent);
    const account = resolveAccount(rt.loadedConfig.config, agentId, options.account);
    const { adapter, context } = providerContext(rt, account.provider);
    print(await adapter.readThread(threadId, { agentId, accountId: account.id }, context), options.format);
  });
  threads.command("reply <threadId>").requiredOption("--text <text>").action(
    async (threadId: string, commandOptions: { text: string }) => {
      const options = program.opts<GlobalOptions>();
      const rt = await runtime(options);
      const agentId = resolveActiveAgent(rt.loadedConfig.config, options.agent);
      const account = resolveAccount(rt.loadedConfig.config, agentId, options.account);
      const { adapter, context } = providerContext(rt, account.provider);
      print(
        await adapter.replyToThread({ agentId, accountId: account.id, threadId, text: commandOptions.text }, context),
        options.format,
      );
    },
  );

  const server = program.command("server").description("Run the sample federation server");
  server.command("init").description("Print sample federation provider config").action(() => {
    const options = program.opts<GlobalOptions>();
    print(
      {
        provider: {
          id: "federation",
          type: "federation",
          kind: "custom",
          settings: { url: "http://127.0.0.1:8787" },
          auth: { tokenEnv: "AGENT_MESSAGE_FEDERATION_TOKEN" },
        },
      },
      options.format,
    );
  });
  server.command("start")
    .option("--host <host>", "host", "127.0.0.1")
    .option("--port <port>", "port", "8787")
    .option("--token-env <env>")
    .action(async (commandOptions: { host: string; port: string; tokenEnv?: string }) => {
      const options = program.opts<GlobalOptions>();
      const loaded = await loadConfig(options.config);
      const token = commandOptions.tokenEnv ? process.env[commandOptions.tokenEnv] : undefined;
      await startFederationServer({
        loadedConfig: loaded,
        host: commandOptions.host,
        port: Number(commandOptions.port),
        token,
      });
      console.log(`agent-message federation server listening on http://${commandOptions.host}:${commandOptions.port}`);
    });

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    const options = program.opts<GlobalOptions>();
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (options.verbose && error instanceof Error && error.stack) console.error(error.stack);
    process.exitCode = 1;
  }
}
