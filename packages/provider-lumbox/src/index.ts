import {
  resolveAccount,
  resolveRecipient,
  type AccountConfig,
  type AddressRef,
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

interface LumboxInbox {
  id?: string;
  email?: string;
  address?: string;
  username?: string;
  name?: string;
}

interface LumboxMessage {
  id?: string;
  messageId?: string;
  threadId?: string;
  thread_id?: string;
  from?: string | { address?: string; email?: string; name?: string };
  fromAddress?: string;
  to?: unknown;
  subject?: string;
  text?: string;
  body?: string;
  bodyText?: string;
  html?: string;
  createdAt?: string;
  receivedAt?: string;
  created_at?: string;
  status?: string;
}

interface LumboxThread {
  id?: string;
  threadId?: string;
  thread_id?: string;
  subject?: string;
  messages?: LumboxMessage[];
  participants?: unknown;
  latestAt?: string;
  updatedAt?: string;
  createdAt?: string;
}

function baseUrl(context: ProviderContext): string {
  const configured = context.providerConfig.settings?.baseUrl ?? context.providerConfig.settings?.url;
  return (typeof configured === "string" && configured.length > 0
    ? configured
    : "https://api.lumbox.co").replace(/\/$/, "");
}

function apiKey(context: ProviderContext, account?: AccountConfig): string {
  const envName = typeof account?.auth?.apiKeyEnv === "string"
    ? account.auth.apiKeyEnv
    : typeof context.providerConfig.auth?.apiKeyEnv === "string"
    ? context.providerConfig.auth.apiKeyEnv
    : "LUMBOX_API_KEY";
  const value = process.env[envName];
  if (!value) throw new Error(`Missing Lumbox API key env var '${envName}'.`);
  return value;
}

async function request<T>(
  context: ProviderContext,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    account?: AccountConfig;
    query?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<T> {
  const url = new URL(`${baseUrl(context)}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const key = apiKey(context, options.account);
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${key}`,
      "x-api-key": key,
      "content-type": "application/json",
      "user-agent": "agent-message-lumbox-provider/0.1.0",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    throw new Error(`Lumbox request failed: ${response.status} ${await response.text()}`);
  }
  return await response.json() as T;
}

function inboxId(account: AccountConfig): string {
  const configured = account.settings?.inboxId;
  return typeof configured === "string" && configured.length > 0 ? configured : account.id;
}

function localPart(input: CreateAccountInput): string {
  const value = input.address?.split("@")[0] ?? input.name ?? input.agentId;
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || input.agentId;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstString(value[0]);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return firstString(object.address) ?? firstString(object.email) ?? firstString(object.value);
  }
  return undefined;
}

function addressRef(provider: string, value: unknown): AddressRef {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    return {
      provider,
      address: firstString(object.address) ?? firstString(object.email) ?? "unknown",
      displayName: firstString(object.name),
    };
  }
  return { provider, address: firstString(value) ?? "unknown" };
}

function addressRefs(provider: string, value: unknown): AddressRef[] {
  if (Array.isArray(value)) return value.map((item) => addressRef(provider, item));
  const address = firstString(value);
  return address ? [{ provider, address }] : [];
}

function data<T>(response: unknown, key: string): T {
  if (response && typeof response === "object") {
    const object = response as Record<string, unknown>;
    if (object[key] && typeof object[key] === "object") return object[key] as T;
    if (object.data && typeof object.data === "object") return object.data as T;
  }
  return response as T;
}

function list<T>(response: unknown, keys: string[]): T[] {
  if (Array.isArray(response)) return response as T[];
  if (response && typeof response === "object") {
    const object = response as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(object[key])) return object[key] as T[];
    }
    if (Array.isArray(object.data)) return object.data as T[];
    if (Array.isArray(object.items)) return object.items as T[];
  }
  return [];
}

function messageId(message: LumboxMessage): string {
  return message.id ?? message.messageId ?? crypto.randomUUID();
}

function mapMessage(provider: string, account: AccountConfig, message: LumboxMessage): MessageEnvelope {
  const from = message.fromAddress ? { provider, address: message.fromAddress } : addressRef(provider, message.from);
  return {
    id: messageId(message),
    threadId: message.threadId ?? message.thread_id ?? messageId(message),
    provider,
    accountId: account.id,
    from,
    to: addressRefs(provider, message.to),
    subject: message.subject,
    text: message.text ?? message.body ?? message.bodyText ?? message.html,
    createdAt: message.createdAt ?? message.receivedAt ?? message.created_at ?? new Date().toISOString(),
    direction: message.status === "sent" || from.address === account.address ? "sent" : "received",
    metadata: { lumbox: message },
  };
}

function mapThread(provider: string, account: AccountConfig, thread: LumboxThread): ThreadView {
  const messages = thread.messages ?? [];
  return {
    id: thread.id ?? thread.threadId ?? thread.thread_id ?? crypto.randomUUID(),
    provider,
    accountId: account.id,
    messageIds: messages.map((message) => messageId(message)),
    participants: addressRefs(provider, thread.participants),
    subject: thread.subject ?? messages.find((message) => message.subject)?.subject,
    latestAt: thread.latestAt ?? thread.updatedAt ?? thread.createdAt ?? new Date().toISOString(),
  };
}

export const lumboxProvider: ProviderAdapter = {
  id: "lumbox",
  type: "lumbox",
  kind: "email",
  capabilities: ["createAccount", "sendDirect", "listMailbox", "readMessage", "listThreads", "readThread", "replyThread"],

  async setup(context: ProviderContext): Promise<SetupResult> {
    return {
      provider: context.providerConfig.id,
      message: "Lumbox provides agent inboxes, OTP-oriented receiving, send, and threaded reply APIs.",
      nextSteps: [
        "Set LUMBOX_API_KEY or configure providers.lumbox.auth.apiKeyEnv.",
        "Optionally set providers.lumbox.settings.baseUrl, defaulting to https://api.lumbox.co.",
        "Create an inbox with: agent-message accounts create lumbox --name support-agent.",
      ],
    };
  },

  async createAccount(input: CreateAccountInput, context: ProviderContext): Promise<AccountConfig> {
    const response = await request<unknown>(context, "/v1/inboxes", {
      method: "POST",
      body: {
        username: localPart(input),
        name: input.name,
      },
    });
    const inbox = data<LumboxInbox>(response, "inbox");
    if (!inbox.id) throw new Error("Lumbox create inbox response did not include id.");
    return {
      id: inbox.id,
      provider: context.providerConfig.id,
      address: inbox.email ?? inbox.address ?? input.address ?? inbox.id,
      displayName: inbox.name ?? inbox.username ?? input.name,
      agents: [input.agentId],
      settings: { inboxId: inbox.id },
    };
  },

  async sendMessage(input: SendMessageInput, context: ProviderContext): Promise<MessageEnvelope> {
    const recipient = resolveRecipient(context.loadedConfig.config, input.to, input.via);
    const account = resolveAccount(context.loadedConfig.config, input.agentId, input.accountId, recipient.provider);
    const response = await request<unknown>(context, `/v1/inboxes/${encodeURIComponent(inboxId(account))}/send`, {
      method: "POST",
      account,
      body: {
        to: recipient.address,
        subject: input.subject,
        text: input.text,
      },
    });
    return mapMessage(context.providerConfig.id, account, {
      ...data<LumboxMessage>(response, "message"),
      from: account.address,
      to: [recipient.address],
      subject: input.subject,
      text: input.text,
      status: "sent",
    });
  },

  async listMailbox(query: MailboxQuery, context: ProviderContext): Promise<MessageEnvelope[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(context, `/v1/inboxes/${encodeURIComponent(inboxId(account))}/messages`, {
      account,
      query: { limit: query.limit ?? 20 },
    });
    return list<LumboxMessage>(response, ["messages"]).map((message) => mapMessage(context.providerConfig.id, account, message));
  },

  async readMessage(messageIdValue: string, query: MailboxQuery, context: ProviderContext): Promise<MessageEnvelope | undefined> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(
      context,
      `/v1/inboxes/${encodeURIComponent(inboxId(account))}/messages/${encodeURIComponent(messageIdValue)}`,
      { account },
    );
    return mapMessage(context.providerConfig.id, account, data<LumboxMessage>(response, "message"));
  },

  async listThreads(query: MailboxQuery, context: ProviderContext): Promise<ThreadView[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(context, `/v1/inboxes/${encodeURIComponent(inboxId(account))}/threads`, {
      account,
      query: { limit: query.limit ?? 20 },
    });
    return list<LumboxThread>(response, ["threads"]).map((thread) => mapThread(context.providerConfig.id, account, thread));
  },

  async readThread(threadIdValue: string, query: MailboxQuery, context: ProviderContext): Promise<MessageEnvelope[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(context, `/v1/threads/${encodeURIComponent(threadIdValue)}`, { account });
    const thread = data<LumboxThread>(response, "thread");
    return (thread.messages ?? []).map((message) => mapMessage(context.providerConfig.id, account, message));
  },

  async replyToThread(input: ReplyToThreadInput, context: ProviderContext): Promise<MessageEnvelope> {
    const account = resolveAccount(context.loadedConfig.config, input.agentId, input.accountId);
    const messages = await this.readThread(input.threadId, { agentId: input.agentId, accountId: account.id }, context);
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) throw new Error(`Thread '${input.threadId}' has no message to reply to.`);
    const response = await request<unknown>(context, `/v1/inboxes/${encodeURIComponent(inboxId(account))}/reply`, {
      method: "POST",
      account,
      body: {
        messageId: lastMessage.id,
        threadId: input.threadId,
        text: input.text,
      },
    });
    return mapMessage(context.providerConfig.id, account, {
      ...data<LumboxMessage>(response, "message"),
      from: account.address,
      text: input.text,
      status: "sent",
    });
  },
};
