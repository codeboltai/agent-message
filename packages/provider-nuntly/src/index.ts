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

interface NuntlyInbox {
  id?: string;
  address?: string;
  domainName?: string;
  name?: string;
}

interface NuntlyMessage {
  id?: string;
  messageId?: string;
  threadId?: string;
  inboxId?: string | null;
  from?: string | { address?: string; name?: string };
  to?: unknown;
  cc?: unknown;
  subject?: string;
  text?: string;
  html?: string;
  status?: string;
  receivedAt?: string;
  createdAt?: string;
}

interface NuntlyThread {
  id?: string;
  threadId?: string;
  subject?: string;
  messageCount?: number;
  messages?: NuntlyMessage[];
  participants?: unknown;
  latestAt?: string;
  updatedAt?: string;
  createdAt?: string;
}

function baseUrl(context: ProviderContext): string {
  const configured = context.providerConfig.settings?.baseUrl ?? context.providerConfig.settings?.url;
  return (typeof configured === "string" && configured.length > 0
    ? configured
    : "https://api.nuntly.com").replace(/\/$/, "");
}

function apiKey(context: ProviderContext, account?: AccountConfig): string {
  const envName = typeof account?.auth?.apiKeyEnv === "string"
    ? account.auth.apiKeyEnv
    : typeof context.providerConfig.auth?.apiKeyEnv === "string"
    ? context.providerConfig.auth.apiKeyEnv
    : "NUNTLY_API_KEY";
  const value = process.env[envName];
  if (!value) throw new Error(`Missing Nuntly API key env var '${envName}'.`);
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
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${apiKey(context, options.account)}`,
      "content-type": "application/json",
      "user-agent": "agent-message-nuntly-provider/0.1.0",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    throw new Error(`Nuntly request failed: ${response.status} ${await response.text()}`);
  }
  return await response.json() as T;
}

function inboxId(account: AccountConfig): string {
  const configured = account.settings?.inboxId;
  return typeof configured === "string" && configured.length > 0 ? configured : account.id;
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

function messageId(message: NuntlyMessage): string {
  return message.id ?? message.messageId ?? crypto.randomUUID();
}

function mapMessage(provider: string, account: AccountConfig, message: NuntlyMessage): MessageEnvelope {
  const from = addressRef(provider, message.from);
  return {
    id: messageId(message),
    threadId: message.threadId ?? messageId(message),
    provider,
    accountId: account.id,
    from,
    to: addressRefs(provider, message.to),
    subject: message.subject,
    text: message.text ?? message.html,
    createdAt: message.receivedAt ?? message.createdAt ?? new Date().toISOString(),
    direction: message.status === "sent" || from.address === account.address ? "sent" : "received",
    metadata: { nuntly: message },
  };
}

function mapThread(provider: string, account: AccountConfig, thread: NuntlyThread): ThreadView {
  const messages = thread.messages ?? [];
  return {
    id: thread.id ?? thread.threadId ?? crypto.randomUUID(),
    provider,
    accountId: account.id,
    messageIds: messages.map((message) => messageId(message)),
    participants: addressRefs(provider, thread.participants),
    subject: thread.subject,
    latestAt: thread.latestAt ?? thread.updatedAt ?? thread.createdAt ?? new Date().toISOString(),
  };
}

function addressLocalPart(input: CreateAccountInput): string {
  const localPart = input.address?.split("@")[0] ?? input.name ?? input.agentId;
  return localPart.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || input.agentId;
}

export const nuntlyProvider: ProviderAdapter = {
  id: "nuntly",
  type: "nuntly",
  kind: "email",
  capabilities: ["createAccount", "sendDirect", "listMailbox", "readMessage", "listThreads", "readThread", "replyThread"],

  async setup(context: ProviderContext): Promise<SetupResult> {
    return {
      provider: context.providerConfig.id,
      message: "Nuntly can create inboxes, read received messages, and reply from agent-owned email addresses.",
      nextSteps: [
        "Set NUNTLY_API_KEY or configure providers.nuntly.auth.apiKeyEnv.",
        "Optionally set providers.nuntly.settings.domainId or namespaceId for inbox creation.",
        "Create an inbox with: agent-message accounts create nuntly --name support-agent.",
      ],
    };
  },

  async createAccount(input: CreateAccountInput, context: ProviderContext): Promise<AccountConfig> {
    const body: Record<string, string> = {
      address: addressLocalPart(input),
      agentId: input.agentId,
    };
    if (input.name) body.name = input.name;
    if (typeof context.providerConfig.settings?.domainId === "string") body.domainId = context.providerConfig.settings.domainId;
    if (typeof context.providerConfig.settings?.namespaceId === "string") body.namespaceId = context.providerConfig.settings.namespaceId;

    const response = await request<unknown>(context, "/inboxes", {
      method: "POST",
      body,
    });
    const inbox = data<NuntlyInbox>(response, "inbox");
    if (!inbox.id) throw new Error("Nuntly create inbox response did not include id.");
    return {
      id: inbox.id,
      provider: context.providerConfig.id,
      address: inbox.domainName ? `${inbox.address}@${inbox.domainName}` : input.address ?? inbox.address ?? inbox.id,
      displayName: inbox.name ?? input.name,
      agents: [input.agentId],
      settings: { inboxId: inbox.id },
    };
  },

  async sendMessage(input: SendMessageInput, context: ProviderContext): Promise<MessageEnvelope> {
    const recipient = resolveRecipient(context.loadedConfig.config, input.to, input.via);
    const account = resolveAccount(context.loadedConfig.config, input.agentId, input.accountId, recipient.provider);
    const response = await request<unknown>(context, `/inboxes/${encodeURIComponent(inboxId(account))}/send`, {
      method: "POST",
      account,
      body: {
        to: [{ address: recipient.address }],
        subject: input.subject,
        text: input.text,
      },
    });
    const message = data<NuntlyMessage>(response, "message");
    return mapMessage(context.providerConfig.id, account, {
      ...message,
      from: account.address,
      to: [{ address: recipient.address }],
      subject: input.subject,
      text: input.text,
      status: "sent",
    });
  },

  async listMailbox(query: MailboxQuery, context: ProviderContext): Promise<MessageEnvelope[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(context, "/messages", {
      account,
      query: { inboxId: inboxId(account), limit: query.limit ?? 20 },
    });
    return list<NuntlyMessage>(response, ["messages"]).map((message) => {
      return mapMessage(context.providerConfig.id, account, message);
    });
  },

  async readMessage(messageIdValue: string, query: MailboxQuery, context: ProviderContext): Promise<MessageEnvelope | undefined> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(context, `/messages/${encodeURIComponent(messageIdValue)}`, { account });
    return mapMessage(context.providerConfig.id, account, data<NuntlyMessage>(response, "message"));
  },

  async listThreads(query: MailboxQuery, context: ProviderContext): Promise<ThreadView[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(context, `/inboxes/${encodeURIComponent(inboxId(account))}/threads`, {
      account,
      query: { limit: query.limit ?? 20 },
    });
    return list<NuntlyThread>(response, ["threads"]).map((thread) => {
      return mapThread(context.providerConfig.id, account, thread);
    });
  },

  async readThread(threadIdValue: string, query: MailboxQuery, context: ProviderContext): Promise<MessageEnvelope[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(context, `/threads/${encodeURIComponent(threadIdValue)}/messages`, { account });
    return list<NuntlyMessage>(response, ["messages"]).map((message) => {
      return mapMessage(context.providerConfig.id, account, message);
    });
  },

  async replyToThread(input: ReplyToThreadInput, context: ProviderContext): Promise<MessageEnvelope> {
    const account = resolveAccount(context.loadedConfig.config, input.agentId, input.accountId);
    const messages = await this.readThread(input.threadId, { agentId: input.agentId, accountId: account.id }, context);
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) throw new Error(`Thread '${input.threadId}' has no message to reply to.`);
    const response = await request<unknown>(context, `/messages/${encodeURIComponent(lastMessage.id)}/reply`, {
      method: "POST",
      account,
      body: {
        text: input.text,
        replyAll: true,
      },
    });
    const message = data<NuntlyMessage>(response, "message");
    return mapMessage(context.providerConfig.id, account, {
      ...message,
      from: account.address,
      text: input.text,
      status: "sent",
    });
  },
};
