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

interface OpenMailInbox {
  id?: string;
  inboxId?: string;
  address?: string;
  email?: string;
  mailboxName?: string;
  name?: string;
}

interface OpenMailMessage {
  id?: string;
  messageId?: string;
  threadId?: string;
  fromAddr?: string;
  from?: string | { address?: string; email?: string; name?: string };
  to?: unknown;
  subject?: string;
  bodyText?: string;
  body?: string;
  text?: string;
  createdAt?: string;
  timestamp?: string;
  direction?: string;
}

interface OpenMailThread {
  id?: string;
  threadId?: string;
  messages?: OpenMailMessage[];
  subject?: string;
  participants?: unknown;
  lastMessageAt?: string;
  createdAt?: string;
  isRead?: boolean;
}

function baseUrl(context: ProviderContext): string {
  const configured = context.providerConfig.settings?.baseUrl ?? context.providerConfig.settings?.url;
  return (typeof configured === "string" ? configured : "https://api.openmail.sh").replace(/\/$/, "");
}

function apiKey(context: ProviderContext, account?: AccountConfig): string {
  const envName = typeof account?.auth?.apiKeyEnv === "string"
    ? account.auth.apiKeyEnv
    : typeof context.providerConfig.auth?.apiKeyEnv === "string"
    ? context.providerConfig.auth.apiKeyEnv
    : "OPENMAIL_API_KEY";
  const value = process.env[envName];
  if (!value) throw new Error(`Missing OpenMail API key env var '${envName}'.`);
  return value;
}

async function request<T>(
  context: ProviderContext,
  path: string,
  options: { method?: string; body?: unknown; account?: AccountConfig; query?: Record<string, string | number | boolean | undefined> } = {},
): Promise<T> {
  const url = new URL(`${baseUrl(context)}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey(context, options.account)}`,
    "content-type": "application/json",
    "user-agent": "agent-message-openmail-provider/0.1.0",
  };
  if (options.method === "POST" && path.includes("/send")) {
    headers["idempotency-key"] = crypto.randomUUID();
  }
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    throw new Error(`OpenMail request failed: ${response.status} ${await response.text()}`);
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

function ref(provider: string, value: unknown): AddressRef {
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

function refs(provider: string, value: unknown): AddressRef[] {
  if (Array.isArray(value)) return value.map((item) => ref(provider, item));
  const address = firstString(value);
  return address ? [{ provider, address }] : [];
}

function list<T>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(object[key])) return object[key] as T[];
    }
    if (Array.isArray(object.data)) return object.data as T[];
  }
  return [];
}

function mapMessage(provider: string, account: AccountConfig, message: OpenMailMessage): MessageEnvelope {
  const from = message.fromAddr ? { provider, address: message.fromAddr } : ref(provider, message.from);
  return {
    id: message.id ?? message.messageId ?? crypto.randomUUID(),
    threadId: message.threadId ?? message.id ?? message.messageId ?? crypto.randomUUID(),
    provider,
    accountId: account.id,
    from,
    to: refs(provider, message.to),
    subject: message.subject,
    text: message.bodyText ?? message.body ?? message.text,
    createdAt: message.createdAt ?? message.timestamp ?? new Date().toISOString(),
    direction: from.address === account.address ? "sent" : "received",
    metadata: { openmail: message },
  };
}

function mapThread(provider: string, account: AccountConfig, thread: OpenMailThread): ThreadView {
  const messages = thread.messages ?? [];
  return {
    id: thread.id ?? thread.threadId ?? crypto.randomUUID(),
    provider,
    accountId: account.id,
    messageIds: messages.map((message) => message.id ?? message.messageId ?? "").filter(Boolean),
    participants: refs(provider, thread.participants),
    subject: thread.subject,
    latestAt: thread.lastMessageAt ?? thread.createdAt ?? new Date().toISOString(),
  };
}

export const openMailProvider: ProviderAdapter = {
  id: "openmail",
  type: "openmail",
  kind: "email",
  capabilities: ["createAccount", "sendDirect", "listMailbox", "readMessage", "listThreads", "readThread", "replyThread"],

  async setup(context: ProviderContext): Promise<SetupResult> {
    return {
      provider: context.providerConfig.id,
      message: "OpenMail gives agents dedicated inboxes with send, receive, and threaded replies.",
      nextSteps: [
        "Set OPENMAIL_API_KEY or configure providers.openmail.auth.apiKeyEnv.",
        "Optionally set providers.openmail.settings.baseUrl, defaulting to https://api.openmail.sh.",
        "Create an inbox with: agent-message accounts create openmail --name support-agent.",
      ],
    };
  },

  async createAccount(input: CreateAccountInput, context: ProviderContext): Promise<AccountConfig> {
    const inbox = await request<OpenMailInbox>(context, "/v1/inboxes", {
      method: "POST",
      body: { mailboxName: input.name ?? input.agentId },
    });
    const id = inbox.id ?? inbox.inboxId;
    if (!id) throw new Error("OpenMail create inbox response did not include id.");
    return {
      id,
      provider: context.providerConfig.id,
      address: inbox.address ?? inbox.email ?? input.address ?? id,
      displayName: inbox.name ?? inbox.mailboxName ?? input.name,
      agents: [input.agentId],
      settings: { inboxId: id },
    };
  },

  async sendMessage(input: SendMessageInput, context: ProviderContext): Promise<MessageEnvelope> {
    const recipient = resolveRecipient(context.loadedConfig.config, input.to, input.via);
    const account = resolveAccount(context.loadedConfig.config, input.agentId, input.accountId, recipient.provider);
    const message = await request<OpenMailMessage>(context, `/v1/inboxes/${encodeURIComponent(inboxId(account))}/send`, {
      method: "POST",
      account,
      body: { to: recipient.address, subject: input.subject, body: input.text },
    });
    return mapMessage(context.providerConfig.id, account, message);
  },

  async listMailbox(query: MailboxQuery, context: ProviderContext): Promise<MessageEnvelope[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(context, `/v1/inboxes/${encodeURIComponent(inboxId(account))}/messages`, {
      account,
      query: { direction: "inbound", limit: query.limit ?? 20 },
    });
    return list<OpenMailMessage>(response, ["messages"]).map((message) => mapMessage(context.providerConfig.id, account, message));
  },

  async readMessage(messageId: string, query: MailboxQuery, context: ProviderContext): Promise<MessageEnvelope | undefined> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const message = await request<OpenMailMessage>(context, `/v1/inboxes/${encodeURIComponent(inboxId(account))}/messages/${encodeURIComponent(messageId)}`, { account });
    return mapMessage(context.providerConfig.id, account, message);
  },

  async listThreads(query: MailboxQuery, context: ProviderContext): Promise<ThreadView[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const response = await request<unknown>(context, `/v1/inboxes/${encodeURIComponent(inboxId(account))}/threads`, {
      account,
      query: { limit: query.limit ?? 20 },
    });
    return list<OpenMailThread>(response, ["threads"]).map((thread) => mapThread(context.providerConfig.id, account, thread));
  },

  async readThread(threadId: string, query: MailboxQuery, context: ProviderContext): Promise<MessageEnvelope[]> {
    const account = resolveAccount(context.loadedConfig.config, query.agentId, query.accountId);
    const thread = await request<OpenMailThread>(context, `/v1/inboxes/${encodeURIComponent(inboxId(account))}/threads/${encodeURIComponent(threadId)}`, { account });
    return (thread.messages ?? []).map((message) => mapMessage(context.providerConfig.id, account, message));
  },

  async replyToThread(input: ReplyToThreadInput, context: ProviderContext): Promise<MessageEnvelope> {
    const account = resolveAccount(context.loadedConfig.config, input.agentId, input.accountId);
    const message = await request<OpenMailMessage>(context, `/v1/inboxes/${encodeURIComponent(inboxId(account))}/send`, {
      method: "POST",
      account,
      body: { threadId: input.threadId, body: input.text },
    });
    return mapMessage(context.providerConfig.id, account, message);
  },
};
