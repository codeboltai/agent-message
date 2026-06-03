import {
  resolveAccount,
  resolveRecipient,
  type AccountConfig,
  type CreateAccountInput,
  type MailboxQuery,
  type MessageEnvelope,
  type ProviderAdapter,
  type ProviderContext,
  type ReplyToThreadInput,
  type SendMessageInput,
  type SetupResult,
  type ThreadView,
} from "@codebolt/agent-message-core";

function baseUrl(context: ProviderContext): string {
  const url = context.providerConfig.settings?.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`Federation provider '${context.providerConfig.id}' needs settings.url.`);
  }
  return url.replace(/\/$/, "");
}

function authHeaders(context: ProviderContext): Record<string, string> {
  const tokenEnv = context.providerConfig.auth?.tokenEnv;
  if (typeof tokenEnv !== "string") return {};
  const token = process.env[tokenEnv];
  if (!token) throw new Error(`Missing federation token env var '${tokenEnv}'.`);
  return { authorization: `Bearer ${token}` };
}

async function request<T>(
  context: ProviderContext,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${baseUrl(context)}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeaders(context),
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`Federation request failed: ${response.status} ${await response.text()}`);
  }
  return await response.json() as T;
}

export const federationProvider: ProviderAdapter = {
  id: "federation",
  type: "federation",
  kind: "custom",
  capabilities: [
    "createAccount",
    "sendDirect",
    "listMailbox",
    "readMessage",
    "listThreads",
    "readThread",
    "replyThread",
  ],

  async setup(context: ProviderContext): Promise<SetupResult> {
    return {
      provider: context.providerConfig.id,
      message: "Federation provider connects to an Agent-message federation server.",
      nextSteps: [
        "Set provider settings.url to the federation server base URL.",
        "Optionally set auth.tokenEnv to an environment variable containing the bearer token.",
      ],
    };
  },

  async createAccount(
    input: CreateAccountInput,
    context: ProviderContext,
  ): Promise<AccountConfig> {
    return await request<AccountConfig>(context, "/accounts", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  async sendMessage(
    input: SendMessageInput,
    context: ProviderContext,
  ): Promise<MessageEnvelope> {
    const recipient = resolveRecipient(context.loadedConfig.config, input.to, input.via);
    const account = resolveAccount(
      context.loadedConfig.config,
      input.agentId,
      input.accountId,
      recipient.provider,
    );
    return await request<MessageEnvelope>(context, "/messages", {
      method: "POST",
      body: JSON.stringify({ ...input, accountId: account.id, to: recipient }),
    });
  },

  async listMailbox(
    query: MailboxQuery,
    context: ProviderContext,
  ): Promise<MessageEnvelope[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    return await request<MessageEnvelope[]>(
      context,
      `/mailbox/${encodeURIComponent(account.id)}/messages?limit=${query.limit ?? 20}`,
    );
  },

  async readMessage(
    messageId: string,
    query: MailboxQuery,
    context: ProviderContext,
  ): Promise<MessageEnvelope | undefined> {
    resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    return await request<MessageEnvelope | undefined>(context, `/messages/${encodeURIComponent(messageId)}`);
  },

  async listThreads(query: MailboxQuery, context: ProviderContext): Promise<ThreadView[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    return await request<ThreadView[]>(
      context,
      `/mailbox/${encodeURIComponent(account.id)}/threads?limit=${query.limit ?? 20}`,
    );
  },

  async readThread(
    threadId: string,
    query: MailboxQuery,
    context: ProviderContext,
  ): Promise<MessageEnvelope[]> {
    resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    return await request<MessageEnvelope[]>(context, `/threads/${encodeURIComponent(threadId)}`);
  },

  async replyToThread(
    input: ReplyToThreadInput,
    context: ProviderContext,
  ): Promise<MessageEnvelope> {
    const account = resolveAccount(context.loadedConfig.config, input.agentId, input.accountId);
    return await request<MessageEnvelope>(
      context,
      `/threads/${encodeURIComponent(input.threadId)}/replies`,
      {
        method: "POST",
        body: JSON.stringify({ ...input, accountId: account.id }),
      },
    );
  },
};
